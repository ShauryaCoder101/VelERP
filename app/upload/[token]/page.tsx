"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import FolderPicker from "../../components/FolderPicker";
import MediaGallery, { type GalleryItem } from "../../components/MediaGallery";
import { MULTIPART_THRESHOLD } from "../../../lib/upload-client";
import { isQuotaError, notifyUploadBatch, QUOTA_MESSAGE, uploadMediaFile } from "../../../lib/media-upload";
import { markAsDirectoryInput, readDataTransfer, readFileInput, type DroppedFile } from "../../../lib/file-drop";
import "./upload.css";

/* The open upload link: a photographer in another state, with no account,
 * putting a shoot into Velocity's storage.
 *
 * Three facts shape every decision here.
 *
 *   The URL is the credential. There is no sign-in, no password and nothing to
 *   provision, because the firm has one login and thirty photographers. What
 *   the page asks for instead is a name — once, on the first visit — and that
 *   name becomes a folder inside the firm's folder. The browser keeps a secret
 *   so the same device lands in the same folder next time; the name itself
 *   proves nothing and is not meant to.
 *
 *   It is read-only except for adding. A contributor can see everything the
 *   firm has delivered for this event and download it, and can create folders
 *   inside their own. There is no delete, rename, move or replace control on
 *   this page, and no endpoint behind it that would accept one. The same rule
 *   the firm's own login lives under.
 *
 *   It has to survive a wedding. Thousands of files, hours of uploading, a
 *   hotel connection: so files go up one at a time with the File objects held
 *   by reference (never read into memory until their turn), one failure never
 *   strands the rest, the queue is windowed rather than rendered in full, and
 *   the quota message that stops the batch says so once instead of once per
 *   remaining file.
 */

/* lib/upload-links.ts is server-only — it reaches for prisma and node:crypto —
   so the two header names are repeated rather than imported. They are a wire
   format shared with the API; changing one side alone breaks every link. */
const LINK_HEADER = "x-upload-link";
const CONTRIBUTOR_HEADER = "x-upload-contributor";

type LinkInfo = {
  link: { id: string; label: string | null; expiresAt: string; status: string };
  event: { id: string; name: string; company: string; fromDate: string; toDate: string };
  firm: { name: string; folder: string };
  quota: { remainingBytes: number };
};

/** What the browser keeps so a returning device is recognised as the same person. */
type Credential = { id: string; secret: string; name: string; folder: string };

type Me = {
  contributor: { id: string; name: string; folder: string };
  uploadRoot: string;
  viewRoot: string;
  quota: { remainingBytes: number };
};

type ItemStatus = "queued" | "uploading" | "done" | "error";

type Item = {
  id: string;
  file: File;
  /** Folder the file was dragged in under ("Day 1/Stage"); empty for a loose file. */
  path: string;
  status: ItemStatus;
  pct: number;
  error?: string;
};

/* Storage is sold and billed in decimal units and the firm's allowance is a
   round 1 TB, so it is shown in decimal — "931 GiB of 1 TB" reads as a bug. */
const GB = 1_000_000_000;

const formatBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatAllowance = (bytes: number) => {
  if (bytes >= 1_000 * GB) return `${(bytes / (1_000 * GB)).toFixed(bytes % (1_000 * GB) === 0 ? 0 : 2)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
};

const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return iso;
  }
};

/* Signed media URLs live an hour. Refreshed comfortably inside that window so a
   gallery left open while a shoot uploads never becomes a grid of dead images. */
const REFRESH_AFTER_MS = 50 * 60_000;

/* The queue is a progress display, not a file manager. Past this many files the
   list shows what is moving and what broke rather than four thousand rows the
   browser then has to re-paint on every percent. */
const MAX_ROWS = 120;

const storageKey = (linkId: string) => `velocity-upload-contributor:${linkId}`;

/* Every localStorage touch is wrapped: Safari in private mode throws on read as
   well as write, and a browser that cannot remember the person is only a
   browser that asks for their name again. */
const readCredential = (linkId: string): Credential | null => {
  try {
    const raw = window.localStorage.getItem(storageKey(linkId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Credential> | null;
    if (typeof parsed?.id !== "string" || typeof parsed?.secret !== "string") return null;
    return {
      id: parsed.id,
      secret: parsed.secret,
      name: typeof parsed.name === "string" ? parsed.name : "",
      folder: typeof parsed.folder === "string" ? parsed.folder : ""
    };
  } catch {
    return null;
  }
};

const writeCredential = (linkId: string, credential: Credential) => {
  try {
    window.localStorage.setItem(storageKey(linkId), JSON.stringify(credential));
  } catch {
    /* They stay signed in for this visit and are asked again on the next one. */
  }
};

const forgetCredential = (linkId: string) => {
  try {
    window.localStorage.removeItem(storageKey(linkId));
  } catch {
    /* Nothing to do: the credential is already unusable to this page. */
  }
};

const joinPath = (...parts: string[]) => parts.filter(Boolean).join("/");

export default function PublicUploadPage() {
  const { token } = useParams<{ token: string }>();

  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [loading, setLoading] = useState(true);
  /* Why the page cannot be used at all: a dead link, a mistyped token, a
     network that is down. Distinct from `notice`, which is about an upload. */
  const [gone, setGone] = useState("");

  const [credential, setCredential] = useState<Credential | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  const [nameDraft, setNameDraft] = useState("");
  const [naming, setNaming] = useState(false);
  const [nameError, setNameError] = useState("");

  const [folders, setFolders] = useState<string[]>([]);
  const [target, setTarget] = useState("");

  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [blocked, setBlocked] = useState("");
  const abort = useRef<AbortController | null>(null);

  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [galleryError, setGalleryError] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
  const galleryAt = useRef(0);

  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => markAsDirectoryInput(folderRef.current), [me]);

  /** The two headers that stand in for a session on every call this page makes. */
  const auth = useMemo(
    () =>
      credential
        ? { [LINK_HEADER]: token, [CONTRIBUTOR_HEADER]: `${credential.id}.${credential.secret}` }
        : null,
    [credential, token]
  );

  const base = `/api/upload-links/public/${encodeURIComponent(token)}`;

  /* ── Who is this link, and are we anybody on it ───────────────────────── */

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(base);
        const body = await res.json().catch(() => null);
        if (!live) return;
        if (!res.ok) {
          setGone(body?.error || "This upload link is no longer active.");
          return;
        }
        const payload = body as LinkInfo;
        setInfo(payload);
        setCredential(readCredential(payload.link.id));
      } catch {
        if (live) setGone("The upload page could not be reached. Check your connection and try again.");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [base]);

  useEffect(() => {
    document.title = info ? `Upload — ${info.event.name}` : "Upload — Velocity";
  }, [info]);

  const loadFolders = useCallback(async () => {
    if (!auth) return;
    const res = await fetch(`${base}/folders`, { headers: auth });
    if (!res.ok) return;
    const body = (await res.json().catch(() => null)) as { folders?: string[] } | null;
    setFolders(body?.folders ?? []);
  }, [auth, base]);

  const loadGallery = useCallback(
    async (quiet: boolean) => {
      if (!auth) return;
      try {
        const res = await fetch(`${base}/media`, { headers: auth });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error || "The gallery could not be loaded.");
        galleryAt.current = Date.now();
        setGallery((body?.items ?? []) as GalleryItem[]);
        if (!quiet) setGalleryError("");
      } catch (err) {
        /* A failed background refresh is not worth tearing down a working
           gallery — the URLs on screen are valid until they age out. */
        if (!quiet) setGalleryError(err instanceof Error ? err.message : "The gallery could not be loaded.");
      }
    },
    [auth, base]
  );

  /** Re-reads the person and the firm's remaining space; also the liveness check. */
  const loadMe = useCallback(
    async (quiet: boolean) => {
      if (!auth || !info) return;
      try {
        const res = await fetch(`${base}/me`, { headers: auth });
        const body = await res.json().catch(() => null);
        if (res.status === 401) {
          /* The credential this browser kept is no longer good — the link was
             replaced, or the row is gone. Forget it and ask for a name again
             rather than leaving a dead page on screen. */
          forgetCredential(info.link.id);
          setCredential(null);
          setMe(null);
          return;
        }
        if (!res.ok || !body?.uploadRoot) {
          /* `me` staying null is what keeps the load effect armed, so a reply
             that is somehow not a contributor has to end the attempt here
             rather than leaving the page re-asking forever. */
          if (!quiet) setGone(body?.error || "This upload link is no longer active.");
          return;
        }
        setMe(body as Me);
      } catch {
        if (!quiet) setGone("The upload page could not be reached. Check your connection and try again.");
      }
    },
    [auth, base, info]
  );

  // First load for a browser that arrived already holding a credential.
  useEffect(() => {
    if (!auth || !info || me) return;
    void loadMe(false);
  }, [auth, info, me, loadMe]);

  useEffect(() => {
    if (!me) return;
    void loadFolders();
    void loadGallery(false);
  }, [me, loadFolders, loadGallery]);

  /* Re-sign on a timer and whenever the tab comes back: a backgrounded tab
     throttles its timers, so returning after lunch would show broken images. */
  useEffect(() => {
    if (!me) return;
    const refreshIfStale = () => {
      if (Date.now() - galleryAt.current >= REFRESH_AFTER_MS) void loadGallery(true);
    };
    const timer = window.setInterval(refreshIfStale, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshIfStale();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refreshIfStale);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refreshIfStale);
    };
  }, [me, loadGallery]);

  /* A batch can run for hours. Closing the tab mid-file loses that file, so the
     browser is asked to confirm — the only guard available to a page that
     cannot resume an upload it did not finish. */
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  /* ── Becoming somebody ────────────────────────────────────────────────── */

  const claimName = async () => {
    if (!info) return;
    const wanted = nameDraft.trim();
    if (!wanted) {
      setNameError("Enter your name so your uploads can be kept together.");
      return;
    }
    setNaming(true);
    setNameError("");
    try {
      const res = await fetch(`${base}/contributors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: wanted })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Your name could not be saved. Try again.");
      const fresh: Credential = {
        id: body.contributor.id,
        secret: body.secret,
        name: body.contributor.name,
        folder: body.contributor.folder
      };
      writeCredential(info.link.id, fresh);
      setNameDraft("");
      // The roots arrive from /me, which the credential now unlocks.
      setCredential(fresh);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Your name could not be saved. Try again.");
    } finally {
      setNaming(false);
    }
  };

  /** Forgets this device's identity. The folder and everything in it stays put. */
  const startOver = () => {
    if (!info || busy) return;
    forgetCredential(info.link.id);
    setCredential(null);
    setMe(null);
    setFolders([]);
    setTarget("");
    setItems([]);
    setGallery([]);
    setNotice("");
    setBlocked("");
    setGalleryError("");
  };

  /* ── The queue ────────────────────────────────────────────────────────── */

  const addFiles = (incoming: DroppedFile[]) => {
    if (incoming.length === 0) return;
    setNotice("");
    setBlocked("");
    const stamp = Date.now();
    setItems((prev) => [
      ...prev,
      ...incoming.map(({ file, path }, i) => ({
        id: `${stamp}-${prev.length + i}-${file.name}`,
        file,
        path,
        status: "queued" as ItemStatus,
        pct: 0
      }))
    ]);
  };

  const patch = (id: string, next: Partial<Item>) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...next } : i)));

  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id));

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    addFiles(await readDataTransfer(e.dataTransfer));
  };

  const pending = useMemo(() => items.filter((i) => i.status === "queued" || i.status === "error"), [items]);
  const doneCount = useMemo(() => items.filter((i) => i.status === "done").length, [items]);
  const queueBytes = useMemo(() => items.reduce((sum, i) => sum + i.file.size, 0), [items]);

  /* Bytes rather than files, so one 40 GB video does not sit at "3 of 4" for an
     hour. The file in flight contributes its own percentage. */
  const movedBytes = useMemo(
    () =>
      items.reduce(
        (sum, i) =>
          sum + (i.status === "done" ? i.file.size : i.status === "uploading" ? (i.file.size * i.pct) / 100 : 0),
        0
      ),
    [items]
  );

  const shown = useMemo(() => {
    if (items.length <= MAX_ROWS) return items;
    const by = (status: ItemStatus) => items.filter((i) => i.status === status);
    // What is happening, what went wrong, then the head of what is waiting.
    return [...by("uploading"), ...by("error"), ...by("queued")].slice(0, MAX_ROWS);
  }, [items]);

  const handleUpload = async () => {
    if (!info || !me || !auth) return;
    if (pending.length === 0) {
      setNotice("Add photos, videos or a folder first.");
      return;
    }

    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setNotice("");
    setBlocked("");

    const queue = [...pending];
    const eventId = info.event.id;
    const batchBytes = queue.reduce((sum, i) => sum + i.file.size, 0);

    /* Fire-and-forget on both ends: an upload must never wait on, or fail
       because of, a mail server. The server attributes it to this person
       "via" the firm. */
    const notify = (phase: "start" | "end", failed = 0) =>
      notifyUploadBatch({ eventId, phase, fileCount: queue.length, totalBytes: batchBytes, failed, headers: auth });

    void notify("start");

    let failures = 0;
    let stopped = 0;
    /* The server's own words for why the batch stopped: the firm's allowance is
       only one of the reasons now, and the in-progress ceilings name whose
       limit was hit (yours, this link's, the firm's). */
    let stoppedBecause = "";
    let cancelled = 0;
    let thumbFailures = 0;

    for (let index = 0; index < queue.length; index += 1) {
      if (controller.signal.aborted) {
        cancelled = queue.length - index;
        for (const rest of queue.slice(index)) patch(rest.id, { status: "queued", pct: 0 });
        break;
      }

      const item = queue[index];
      patch(item.id, { status: "uploading", pct: 0, error: undefined });

      /* Every patch walks the whole queue and re-renders the list, and a
         four-thousand-file shoot makes that the most frequent work on the page.
         Two percentage points is below what anyone can see move. */
      let shownPct = 0;

      try {
        const { derivativeFailures } = await uploadMediaFile({
          file: item.file,
          eventId,
          /* Relative to THIS person's folder — the server prepends the firm and
             their own folder, so the dragged-in directory structure survives
             without the browser ever naming a path it could escape through. */
          relativePath: joinPath(target, item.path),
          headers: auth,
          signal: controller.signal,
          onProgress: (pct) => {
            if (pct < 100 && pct - shownPct < 2) return;
            shownPct = pct;
            patch(item.id, { pct });
          }
        });
        thumbFailures += derivativeFailures;
        patch(item.id, { status: "done", pct: 100 });
      } catch (err) {
        if (controller.signal.aborted) {
          cancelled = queue.length - index;
          for (const rest of queue.slice(index)) patch(rest.id, { status: "queued", pct: 0 });
          break;
        }

        const message = err instanceof Error ? err.message : "Upload failed";
        patch(item.id, { status: "error", error: message });
        failures += 1;

        /* Out of space, or too much already in flight, is not a per-file
           problem: every remaining file would fail the same way, so the batch
           stops and says it once. */
        if (isQuotaError(err)) {
          stopped = queue.length - index - 1;
          stoppedBecause = message;
          for (const rest of queue.slice(index + 1)) patch(rest.id, { status: "queued", pct: 0 });
          break;
        }
      }
    }

    abort.current = null;
    setBusy(false);
    void notify("end", failures);

    // The allowance moved and so did the gallery, whether or not everything landed.
    await loadMe(true);
    void loadFolders();
    void loadGallery(true);

    if (cancelled > 0) {
      setNotice(
        `Stopped. ${cancelled} file${cancelled !== 1 ? "s are" : " is"} still queued — press Upload to carry on.`
      );
      return;
    }

    if (stopped > 0) {
      /* A full allowance needs somebody to ring Velocity; the in-progress
         ceilings clear themselves in minutes and name whose limit it was, so
         the two must not share a sentence. The server knows which it is, so
         its message is shown verbatim and only the queue count is added. */
      const waiting = `${stopped} file${stopped !== 1 ? "s are" : " is"} still queued.`;
      setBlocked(
        stoppedBecause.startsWith(QUOTA_MESSAGE)
          ? `${info.firm.name}'s storage allowance is full, so the upload stopped — ${waiting} Ask ${info.firm.name} to have Velocity free up room before trying again.`
          : `${stoppedBecause} The upload stopped, so ${waiting} Press Upload to carry on once it clears.`
      );
      return;
    }

    const ok = queue.length - failures;
    setNotice(
      (failures === 0
        ? `${ok} file${ok !== 1 ? "s" : ""} uploaded.`
        : `${ok} uploaded, ${failures} failed. Press Upload again to retry the failures.`) +
        (thumbFailures > 0
          ? ` ${thumbFailures} preview image${
              thumbFailures !== 1 ? "s" : ""
            } could not be saved — those files are safely stored, but their tiles will load the full version.`
          : "")
    );
  };

  const createFolder = async (parentRelative: string, name: string) => {
    if (!auth) throw new Error("Open the link again and enter your name.");
    const res = await fetch(`${base}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ parent: parentRelative, name })
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || "The folder could not be created.");
    const { path, relative } = body as { path: string; relative: string };
    setFolders((prev) => (prev.includes(path) ? prev : [...prev, path].sort((a, b) => a.localeCompare(b))));
    return relative;
  };

  /* Lazy signing for the in-browser ZIP. The link and the credential are
     re-checked on every batch, so a link closed mid-download stops the next
     one rather than letting an hour-old page finish the set. */
  const signIds = useCallback(
    async (ids: string[], signal: AbortSignal) => {
      if (!auth) throw new Error("Open the link again and enter your name.");
      const res = await fetch(`${base}/media/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ ids }),
        signal
      });
      if (!res.ok) throw new Error(`Media server returned ${res.status}`);
      const body = await res.json();
      return (body.urls ?? {}) as Record<string, string>;
    },
    [auth, base]
  );

  const mineCount = useMemo(() => gallery.filter((i) => i.mine).length, [gallery]);
  const visibleGallery = useMemo(() => (onlyMine ? gallery.filter((i) => i.mine) : gallery), [gallery, onlyMine]);

  /* ── States ───────────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="share-state">
        <p className="muted">Opening upload page…</p>
      </div>
    );
  }

  if (gone || !info) {
    return (
      <div className="share-state">
        <h1>This upload link is no longer active</h1>
        <p className="muted">{gone || "This upload link is no longer active."}</p>
        <p className="muted">
          Please ask the studio you are shooting for to send you a new one. Anything you have already uploaded is
          safe with Velocity.
        </p>
      </div>
    );
  }

  const sameDay = fmtDate(info.event.fromDate) === fmtDate(info.event.toDate);
  const dates = sameDay
    ? fmtDate(info.event.fromDate)
    : `${fmtDate(info.event.fromDate)} — ${fmtDate(info.event.toDate)}`;

  const head = (
    <div className="share-head">
      <span className="share-eyebrow">{info.event.company}</span>
      <h1>{info.event.name}</h1>
      <p className="share-dates">
        {dates} · uploading for {info.firm.name}
        {info.link.label ? ` · ${info.link.label}` : ""}
      </p>
    </div>
  );

  // No credential yet, or one this link no longer recognises: ask for a name.
  if (!credential) {
    return (
      <>
        {head}
        <div className="up-gate">
          <h2>Who&rsquo;s uploading?</h2>
          <p className="muted">
            Your files go into a folder with your name and today&rsquo;s date, inside {info.firm.name}&rsquo;s
            folder for this event — so everyone&rsquo;s work stays separate and nothing gets mixed up.
          </p>
          <label className="auth-label" htmlFor="up-name">Your name</label>
          <input
            id="up-name"
            className="input"
            value={nameDraft}
            maxLength={60}
            autoFocus
            autoComplete="name"
            disabled={naming}
            placeholder="Ravi Kumar"
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void claimName();
              }
            }}
          />
          {nameError && <div className="auth-error" role="alert">{nameError}</div>}
          <button className="btn-primary auth-submit" type="button" disabled={naming} onClick={() => void claimName()}>
            {naming ? "Just a moment…" : "Start uploading"}
          </button>
          <span className="cell-meta">
            This browser remembers you, so you come back to the same folder. No account, no password.
          </span>
        </div>
      </>
    );
  }

  if (!me) {
    return (
      <>
        {head}
        <div className="share-state">
          <p className="muted">Checking your link…</p>
        </div>
      </>
    );
  }

  const remaining = me.quota.remainingBytes;
  const low = remaining < 25 * GB;
  const overall = queueBytes > 0 ? Math.min(100, (movedBytes / queueBytes) * 100) : 0;

  return (
    <>
      {head}

      <section className="up-card" aria-label="Upload files">
        <div className="up-identity">
          <div className="up-identity-main">
            <span className="up-identity-label">Uploading as</span>
            <strong>{me.contributor.name}</strong>
            <span className="muted">
              into {info.firm.name} / {me.contributor.folder}
            </span>
          </div>
          <button className="link-button" type="button" disabled={busy} onClick={startOver}>
            Not {me.contributor.name}? Use a different name
          </button>
        </div>

        <div className={`up-space${low ? " up-space-low" : ""}`}>
          <span className="up-space-label">Space left for {info.firm.name}</span>
          <span className="up-space-figure">{formatAllowance(remaining)}</span>
        </div>
        {low && (
          <span className="cell-meta">
            Running low. Everyone uploading on {info.firm.name}&rsquo;s links shares the same 1 TB.
          </span>
        )}

        <FolderPicker
          folders={folders}
          uploadRoot={me.uploadRoot}
          value={target}
          onChange={setTarget}
          onCreate={createFolder}
          rootLabel={me.contributor.folder}
          disabled={busy}
        />

        <div
          className={`dropzone${dragging ? " dropzone-active" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <strong>Drop photos, videos or whole folders here</strong>
          <span className="muted">
            Folder names are kept, so &ldquo;Day 1/Stage&rdquo; stays as you shot it. Large files upload in parts,
            and a dropped connection retries that part rather than starting over.
          </span>
          <div className="upload-actions">
            <button className="btn-outline" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
              Select files
            </button>
            <button className="btn-outline" type="button" disabled={busy} onClick={() => folderRef.current?.click()}>
              Select a folder
            </button>
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,video/*,.zip,.rar,.7z"
          style={{ display: "none" }}
          onChange={(e) => {
            addFiles(readFileInput(e.target.files));
            e.target.value = "";
          }}
        />
        <input
          ref={folderRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            addFiles(readFileInput(e.target.files));
            e.target.value = "";
          }}
        />

        {items.length > 0 && (
          <>
            <div className="uploader-list">
              <div className="uploader-list-head">
                <span>
                  {items.length} file{items.length !== 1 ? "s" : ""} · {formatBytes(queueBytes)}
                </span>
                <span>
                  {doneCount > 0 && `${doneCount} uploaded`}
                  {items.length > shown.length && `${doneCount > 0 ? " · " : ""}showing ${shown.length}`}
                </span>
              </div>
              {shown.map((item) => (
                <div key={item.id} className={`uploader-row uploader-${item.status}`}>
                  <span className="uploader-name" title={item.path ? `${item.path}/${item.file.name}` : item.file.name}>
                    {item.file.name}
                    {item.path && <span className="uploader-folder">{item.path}</span>}
                  </span>
                  <span className="uploader-size">
                    {formatBytes(item.file.size)}
                    {item.file.size > MULTIPART_THRESHOLD && <span className="uploader-parts"> · in parts</span>}
                  </span>
                  <span className="uploader-state">
                    {item.status === "queued" && "Queued"}
                    {item.status === "uploading" && `${item.pct}%`}
                    {item.status === "done" && "Uploaded"}
                    {item.status === "error" && (item.error ?? "Failed")}
                  </span>
                  {item.status === "uploading" ? (
                    <span className="uploader-bar"><span style={{ width: `${item.pct}%` }} /></span>
                  ) : (
                    <button
                      className="row-remove"
                      type="button"
                      aria-label={`Remove ${item.file.name} from the queue`}
                      disabled={busy}
                      onClick={() => removeItem(item.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>

            {busy && (
              <div
                className="up-overall"
                role="progressbar"
                aria-label="Overall upload progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(overall)}
              >
                <span style={{ width: `${overall}%` }} />
              </div>
            )}
          </>
        )}

        {blocked && <div className="auth-error" role="alert">{blocked}</div>}
        {notice && <div className="muted">{notice}</div>}

        <div className="up-submit">
          <button className="btn-primary" type="button" onClick={() => void handleUpload()} disabled={busy}>
            {busy
              ? `Uploading… ${Math.round(overall)}%`
              : pending.length > 0
                ? `Upload ${pending.length} file${pending.length !== 1 ? "s" : ""}`
                : "Upload"}
          </button>
          {busy && (
            <button
              className="btn-outline"
              type="button"
              onClick={() => {
                abort.current?.abort();
                setNotice("Stopping after the current file…");
              }}
            >
              Stop
            </button>
          )}
          {!busy && items.length > doneCount && doneCount > 0 && (
            <button
              className="btn-outline"
              type="button"
              onClick={() => setItems((prev) => prev.filter((i) => i.status !== "done"))}
            >
              Clear uploaded
            </button>
          )}
        </div>
      </section>

      <MediaGallery
        items={visibleGallery}
        zipName={info.event.name}
        signIds={signIds}
        emptyMessage={
          onlyMine
            ? "You haven't uploaded anything to this event yet."
            : `Nothing has been uploaded to ${info.firm.name}'s folder for this event yet.`
        }
        header={
          <div className="up-gallery-head">
            <h2>{info.firm.name}&rsquo;s files</h2>
            <div className="up-toggle" role="group" aria-label="Which files to show">
              <button
                type="button"
                className={!onlyMine ? "up-toggle-on" : ""}
                aria-pressed={!onlyMine}
                onClick={() => setOnlyMine(false)}
              >
                Everything from {info.firm.name} ({gallery.length})
              </button>
              <button
                type="button"
                className={onlyMine ? "up-toggle-on" : ""}
                aria-pressed={onlyMine}
                onClick={() => setOnlyMine(true)}
              >
                Only my uploads ({mineCount})
              </button>
            </div>
          </div>
        }
        notice={
          <div className="share-notice">
            <span>Everything {info.firm.name} has delivered for this event, whoever sent it.</span>
            <span className="share-notice-sub">
              View and download. Removing or replacing anything is done by Velocity staff.
              {galleryError ? ` ${galleryError}` : ""}
            </span>
          </div>
        }
      />
    </>
  );
}
