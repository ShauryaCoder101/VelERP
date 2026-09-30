"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { folderFromFileUrl, displayNameFromFileUrl, derivativeUrlFor } from "../../lib/uploadKey";
import { makeDerivatives } from "../../lib/derivatives";
import { uploadFile, MULTIPART_THRESHOLD } from "../../lib/upload-client";
import { isArchived, daysUntilArchived } from "../../lib/archive";
import {
  canSaveZipToDisk,
  downloadOneByOne,
  pickZipFile,
  streamZipToDisk,
  type DownloadQueueProgress,
  type ZipProgress
} from "../../lib/zip-download";

export type UploadRecord = {
  id: string;
  fileUrl: string;
  fileType: string;
  createdAt: string;
  user: { id: string; name: string } | null;
};

type ActiveShare = {
  id: string;
  folder: string | null;
  token: string;
  expiresAt: string;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
  creator: { name: string };
};

type Props = {
  eventId: string;
  uploads: UploadRecord[];
  onUploaded: () => void;
};

type ItemStatus = "queued" | "uploading" | "done" | "error";

type Item = {
  id: string;
  file: File;
  /** folder portion only, "" for loose files */
  path: string;
  status: ItemStatus;
  pct: number;
  error?: string;
};

const UPLOAD_CONCURRENCY = 3;

/* Links for the one-by-one fallback are minted just ahead of the files that
   need them. /api/uploads/view signs for an hour and saving a few thousand
   files takes far longer, so a big batch would hand out links that expire
   before their turn. Five at a time means no URL is more than a few seconds old
   when the browser is pointed at it. */
const DOWNLOAD_SIGN_AHEAD = 5;

const formatBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
};

const contentTypeOf = (file: File) => file.type || "application/octet-stream";
const isImage = (t: string) => t.startsWith("image/");
const isVideo = (t: string) => t.startsWith("video/");

/* Dropped directories arrive as filesystem entries, not files. Walk them so a
   dragged folder keeps its structure instead of collapsing to a flat list. */
const readEntry = (entry: any, parentPath: string, out: { file: File; path: string }[]): Promise<void> =>
  new Promise((resolve) => {
    if (!entry) return resolve();
    if (entry.isFile) {
      entry.file(
        (file: File) => {
          out.push({ file, path: parentPath });
          resolve();
        },
        () => resolve()
      );
      return;
    }
    if (entry.isDirectory) {
      const childPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const reader = entry.createReader();
      const collected: any[] = [];
      const readBatch = () => {
        reader.readEntries(
          (entries: any[]) => {
            if (entries.length === 0) {
              Promise.all(collected.map((e) => readEntry(e, childPath, out))).then(() => resolve());
              return;
            }
            collected.push(...entries);
            readBatch();
          },
          () => resolve()
        );
      };
      readBatch();
      return;
    }
    resolve();
  });

const readDataTransfer = async (dt: DataTransfer) => {
  const out: { file: File; path: string }[] = [];
  const entries = Array.from(dt.items)
    .map((item) => (typeof (item as any).webkitGetAsEntry === "function" ? (item as any).webkitGetAsEntry() : null))
    .filter(Boolean);

  if (entries.length > 0) {
    await Promise.all(entries.map((e: any) => readEntry(e, "", out)));
    return out;
  }
  // Browser without the entries API — plain files only.
  return Array.from(dt.files).map((file) => ({ file, path: "" }));
};

export default function EventMedia({ eventId, uploads, onUploaded }: Props) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);

  const [shareOpen, setShareOpen] = useState(false);
  const [shareFolder, setShareFolder] = useState("");
  const [shareDays, setShareDays] = useState(7);
  const [shareLink, setShareLink] = useState("");
  const [shares, setShares] = useState<ActiveShare[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [shareExpires, setShareExpires] = useState<number | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const [signed, setSigned] = useState<Record<string, string>>({});
  const [loadingMedia, setLoadingMedia] = useState(false);
  const [lightbox, setLightbox] = useState<UploadRecord | null>(null);
  const [restoreState, setRestoreState] = useState<Record<string, string>>({});
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});

  const [zipReady, setZipReady] = useState(false);
  const [zip, setZip] = useState<ZipProgress | null>(null);
  const [zipNote, setZipNote] = useState("");
  const zipAbort = useRef<AbortController | null>(null);

  /* The fallback for browsers that cannot write a stream to disk. */
  const [saveQueue, setSaveQueue] = useState<DownloadQueueProgress | null>(null);
  const saveAbort = useRef<AbortController | null>(null);

  /* After mount, not during render: the server has no showSaveFilePicker, and a
     render-time check would hydrate a different header than it painted. */
  useEffect(() => setZipReady(canSaveZipToDisk()), []);

  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  // webkitdirectory isn't in the React typings; set it on the element directly.
  useEffect(() => {
    if (folderRef.current) {
      folderRef.current.setAttribute("webkitdirectory", "");
      folderRef.current.setAttribute("directory", "");
    }
  }, [uploadOpen]);

  /* ---- grouping for the viewer ---- */
  const groups = useMemo(() => {
    const map = new Map<string, UploadRecord[]>();
    for (const u of uploads) {
      const folder = folderFromFileUrl(u.fileUrl, eventId);
      const list = map.get(folder);
      if (list) list.push(u);
      else map.set(folder, [u]);
    }
    return [...map.entries()]
      .map(([folder, records]) => ({
        folder,
        records,
        uploaders: [...new Set(records.map((r) => r.user?.name).filter(Boolean) as string[])]
      }))
      .sort((a, b) => (a.folder === "" ? -1 : b.folder === "" ? 1 : a.folder.localeCompare(b.folder)));
  }, [uploads, eventId]);

  /* ---- signed URLs, one round trip for the whole gallery ---- */
  const loadSignedUrls = useCallback(async () => {
    // Thumbnails carry the grid; originals are only needed on demand.
    const wanted = uploads.flatMap((u) => [
      u.fileUrl,
      derivativeUrlFor(u.fileUrl, "thumb"),
      derivativeUrlFor(u.fileUrl, "preview")
    ]);
    const missing = [...new Set(wanted.filter((u): u is string => Boolean(u) && !signed[u!]))];
    if (missing.length === 0) return;
    setLoadingMedia(true);
    try {
      const res = await fetch("/api/uploads/view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: missing,
          // Cold originals must be signed against the archive bucket instead.
          archived: uploads.filter((u) => isArchived(u.createdAt)).map((u) => u.fileUrl)
        })
      });
      if (res.ok) {
        const { signed: map } = await res.json();
        setSigned((prev) => ({ ...prev, ...map }));
      }
    } catch {
      /* the viewer shows a per-tile fallback */
    } finally {
      setLoadingMedia(false);
    }
  }, [uploads, signed]);

  const openViewer = () => {
    setViewerOpen(true);
    setOpenFolders((prev) => {
      const next = { ...prev };
      for (const g of groups) if (next[g.folder] === undefined) next[g.folder] = true;
      return next;
    });
    void loadSignedUrls();
  };

  /* ---- the whole event as one ZIP ----
     Built in the browser: a 300GB archive cannot be assembled in a serverless
     function, and doing it client-side keeps the bytes on the free R2 egress
     path instead of pulling them through us twice. See lib/zip-download.ts. */
  const runZip = async (picked: Promise<FileSystemFileHandle>) => {
    let handle: FileSystemFileHandle;
    try {
      handle = await picked;
    } catch {
      return; // save dialog dismissed
    }

    const controller = new AbortController();
    zipAbort.current = controller;
    setZipNote("");
    setZip({ filesDone: 0, filesTotal: uploads.length, skipped: 0, bytesWritten: 0, totalBytes: null, current: "" });

    try {
      const outcome = await streamZipToDisk({
        handle,
        // Iterate the groups so the archive mirrors the folders on screen.
        entries: groups.flatMap((g) =>
          g.records.map((r) => {
            const name = displayNameFromFileUrl(r.fileUrl);
            return {
              key: r.fileUrl,
              path: g.folder ? `${g.folder}/${name}` : name,
              lastModified: r.createdAt,
              /* Cold originals are in Deep Archive; a GET would come back
                 InvalidObjectState, so they are listed rather than fetched. */
              skipReason: isArchived(r.createdAt)
                ? "Original is in cold storage — use Request original on the file first"
                : null
            };
          })
        ),
        sign: async (urls, signal) => {
          const res = await fetch("/api/uploads/view", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls, archived: [] }),
            signal
          });
          if (!res.ok) throw new Error(`Link server returned ${res.status}`);
          const body = await res.json();
          return body.signed ?? {};
        },
        signal: controller.signal,
        onProgress: setZip
      });

      setZipNote(
        outcome.cancelled
          ? "Stopped. The part-written ZIP is incomplete — delete it and start again."
          : `ZIP saved — ${outcome.filesWritten} file${outcome.filesWritten !== 1 ? "s" : ""}, ${formatBytes(outcome.bytesWritten)}.` +
            (outcome.skipped.length > 0
              ? ` ${outcome.skipped.length} could not be included; _NOT_INCLUDED.txt inside the ZIP lists them.`
              : "")
      );
    } catch (err) {
      /* streamZipToDisk names the file it gave up on — the difference between
         "try again" and "that one video is the problem". */
      const why = err instanceof Error && err.message ? ` ${err.message}.` : "";
      setZipNote(`The ZIP could not be finished.${why} Start it again, or download files individually.`);
    } finally {
      zipAbort.current = null;
      setZip(null);
    }
  };

  /* Not async, and the picker runs first: showSaveFilePicker needs the click's
     user activation and the first await would spend it. */
  const startZip = () => {
    if (zip || uploads.length === 0) return;
    void runZip(pickZipFile("Event media.zip"));
  };

  /* ---- the whole event, one file at a time ----
     Safari, Firefox and every phone have no showSaveFilePicker, so there is no
     single-archive path for them at all. Rather than offer nothing, fall back to
     the same queue the client gallery uses (lib/zip-download.ts).

     Every link is signed with `download: true`, so it carries
     Content-Disposition: attachment and the browser streams the file to disk on
     its own. This page never touches the bytes — the earlier version fetched
     each file into a Blob to get a same-origin URL, which on the very browsers
     this path exists for (Safari, iOS) means a multi-GB video is held in memory
     until the tab dies. */
  const runQueueDownloads = async () => {
    const wanted = groups.flatMap((g) =>
      g.records
        // A cold original would come back InvalidObjectState; it needs restoring first.
        .filter((r) => !isArchived(r.createdAt))
        .map((r) => ({ fileUrl: r.fileUrl, name: displayNameFromFileUrl(r.fileUrl) }))
    );
    if (wanted.length === 0 || saveQueue || zip) return;

    const controller = new AbortController();
    saveAbort.current = controller;
    setZipNote("");
    setSaveQueue({ done: 0, total: wanted.length, failed: 0 });

    let done = 0;
    let failed = 0;
    let cancelled = false;

    try {
      for (let i = 0; i < wanted.length && !cancelled; i += DOWNLOAD_SIGN_AHEAD) {
        const slice = wanted.slice(i, i + DOWNLOAD_SIGN_AHEAD);

        let links: Record<string, string> = {};
        try {
          const res = await fetch("/api/uploads/view", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls: slice.map((s) => s.fileUrl), archived: [], download: true }),
            signal: controller.signal
          });
          if (res.ok) links = (await res.json()).signed ?? {};
        } catch {
          /* leave links empty; the whole batch counts as failed below */
        }
        if (controller.signal.aborted) {
          cancelled = true;
          break;
        }

        const ready = slice.filter((s) => links[s.fileUrl]);
        const unsigned = slice.length - ready.length;
        failed += unsigned;
        const base = done;

        const outcome = await downloadOneByOne({
          items: ready.map((s) => ({ url: links[s.fileUrl], name: s.name })),
          signal: controller.signal,
          onProgress: (p) => setSaveQueue({ done: base + p.done, total: wanted.length, failed })
        });

        done = base + outcome.done + unsigned;
        cancelled = outcome.cancelled;
        setSaveQueue({ done, total: wanted.length, failed });
      }
    } finally {
      saveAbort.current = null;
      setSaveQueue(null);
    }

    const saved = done - failed;
    setZipNote(
      cancelled
        ? `Stopped — ${saved} of ${wanted.length} saved.`
        : failed > 0
          ? `${saved} of ${wanted.length} saved. ${failed} could not be downloaded — try again.`
          : `${saved} file${saved !== 1 ? "s" : ""} saved.`
    );
  };

  /* ---- picking files ---- */
  const addFiles = (incoming: { file: File; path: string }[]) => {
    if (incoming.length === 0) return;
    setNotice("");
    setItems((prev) => [
      ...prev,
      ...incoming.map(({ file, path }, i) => ({
        id: `${Date.now()}-${prev.length + i}-${file.name}`,
        file,
        path,
        status: "queued" as ItemStatus,
        pct: 0
      }))
    ]);
  };

  const fromInput = (list: FileList | null) => {
    if (!list) return;
    addFiles(
      Array.from(list).map((file) => {
        const rel = (file as any).webkitRelativePath as string | undefined;
        const path = rel ? rel.split("/").slice(0, -1).join("/") : "";
        return { file, path };
      })
    );
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    addFiles(await readDataTransfer(e.dataTransfer));
  };

  const patch = (id: string, next: Partial<Item>) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...next } : i)));

  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id));

  const totalBytes = items.reduce((s, i) => s + i.file.size, 0);
  const pending = items.filter((i) => i.status === "queued" || i.status === "error");

  /* ---- the upload run ---- */
  const handleUpload = async () => {
    if (pending.length === 0) {
      setNotice("Add photos, videos or a folder first.");
      return;
    }
    setBusy(true);
    setNotice("");

    const queue = [...pending];
    const batchBytes = pending.reduce((sum, i) => sum + i.file.size, 0);
    let failures = 0;
    /* Thumbnails that did not land. Never fatal to a file, but worth saying:
       otherwise the only symptom is blank tiles discovered days later. */
    let derivativeFailures = 0;

    /* Fire-and-forget: the upload must not wait on an email server. */
    const notify = (phase: "start" | "end", failed = 0) =>
      fetch("/api/uploads/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, phase, fileCount: pending.length, totalBytes: batchBytes, failed })
      }).catch(() => {});

    void notify("start");

    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        patch(item.id, { status: "uploading", pct: 0, error: undefined });
        try {
          const presignRes = await fetch("/api/uploads/presign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              eventId,
              fileName: item.file.name,
              fileType: contentTypeOf(item.file),
              relativePath: item.path,
              derivatives: ["thumb", "preview"],
              purpose: "media"
            })
          });
          if (!presignRes.ok) throw new Error("Could not get an upload link");
          const { uploadUrl, fileUrl: simpleUrl, derivatives, reservation } = await presignRes.json();

          /* Shrink here, in the browser, before anything leaves the machine.
             Galleries then read kilobytes instead of the full original. */
          const small = await makeDerivatives(item.file);

          /* The derivatives go up FIRST, before the original.
             presign signs their PUT URLs with a one-hour life. A multi-GB video
             uploaded in parts routinely takes longer than that, so PUTting them
             afterwards — as this used to — meant storage answered 403 and the
             gallery tile stayed blank forever. They are a few hundred KB each,
             so sending them up front costs nothing and they are safely inside
             the signature's life.
             Still best effort: a missing thumbnail only means the viewer falls
             back to the original, and must not fail the file. But it is counted
             and logged rather than swallowed, so a systematic failure is
             visible instead of silently blanking every tile. */
          await Promise.all(
            (["thumb", "preview"] as const).map(async (kind) => {
              const blob = small[kind];
              const slot = derivatives?.[kind];
              if (!blob || !slot) return;
              try {
                const res = await fetch(slot.uploadUrl, {
                  method: "PUT",
                  headers: { "Content-Type": "image/jpeg" },
                  body: blob
                });
                if (!res.ok) throw new Error(`storage returned ${res.status}`);
              } catch (err) {
                derivativeFailures += 1;
                console.warn(`Could not upload the ${kind} for ${item.file.name}`, err);
              }
            })
          );

          /* Small files go up in one PUT; anything larger is split into parts so
             a dropped connection costs one chunk instead of the whole file. */
          const fileUrl = await uploadFile(
            item.file,
            {
              eventId,
              relativePath: item.path,
              purpose: "media",
              presignedUrl: uploadUrl,
              fileUrl: simpleUrl,
              /* Carries presign's key through to the multipart route, so a file
                 over the threshold lands on the key its thumbnail and preview
                 slots were signed against. Without it the derivatives are
                 orphaned and the gallery tile stays blank. */
              reservation
            },
            (pct) => patch(item.id, { pct })
          );

          const recordRes = await fetch("/api/uploads", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ eventId, fileUrl, fileType: contentTypeOf(item.file) })
          });
          if (!recordRes.ok) throw new Error("Uploaded, but could not be recorded");

          patch(item.id, { status: "done", pct: 100 });
        } catch (err) {
          failures += 1;
          patch(item.id, { status: "error", error: err instanceof Error ? err.message : "Upload failed" });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker));

    setBusy(false);
    void notify("end", failures);
    const ok = pending.length - failures;
    setNotice(
      (failures === 0
        ? `${ok} file${ok !== 1 ? "s" : ""} uploaded.`
        : `${ok} uploaded, ${failures} failed. Press Upload again to retry the failures.`) +
        (derivativeFailures > 0
          ? ` ${derivativeFailures} preview image${derivativeFailures !== 1 ? "s" : ""} could not be saved — those tiles will load the full file instead.`
          : "")
    );
    onUploaded();
  };

  const closeUpload = () => {
    if (busy) return;
    setUploadOpen(false);
    setItems([]);
    setNotice("");
  };

  const requestOriginal = async (record: UploadRecord) => {
    setRestoreState((p) => ({ ...p, [record.id]: "Requesting…" }));
    try {
      const res = await fetch("/api/uploads/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: record.id, tier: "Standard" })
      });
      const data = await res.json();
      setRestoreState((p) => ({ ...p, [record.id]: data.message || data.error || "Requested." }));
    } catch {
      setRestoreState((p) => ({ ...p, [record.id]: "Could not start retrieval." }));
    }
  };

  const loadShares = useCallback(async () => {
    try {
      const res = await fetch(`/api/share?eventId=${encodeURIComponent(eventId)}`);
      if (res.ok) setShares(await res.json());
    } catch {
      /* the create form still works without the list */
    }
  }, [eventId]);

  const openShare = () => {
    setShareOpen(true);
    void loadShares();
  };

  const createShareLink = async () => {
    setShareBusy(true);
    setCopied(false);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, folder: shareFolder || null, days: shareDays })
      });
      if (!res.ok) throw new Error();
      const { token, expires } = await res.json();
      setShareLink(`${window.location.origin}/share/${token}`);
      setShareExpires(expires);
      void loadShares();
    } catch {
      setShareLink("");
      setShareExpires(null);
    } finally {
      setShareBusy(false);
    }
  };

  const revokeShare = async (id: string) => {
    await fetch(`/api/share?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    void loadShares();
  };

  const copyExisting = async (token: string, id: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/share/${token}`);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2500);
    } catch {
      /* nothing useful to say */
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* the field is selectable as a fallback */
    }
  };

  const photoCount = uploads.filter((u) => isImage(u.fileType)).length;
  const videoCount = uploads.filter((u) => isVideo(u.fileType)).length;

  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-header claims-header">
        <div>
          <h2>Event media</h2>
          <p className="muted">
            {uploads.length === 0
              ? "No media yet."
              : `${uploads.length} file${uploads.length !== 1 ? "s" : ""}` +
                (photoCount ? ` · ${photoCount} photo${photoCount !== 1 ? "s" : ""}` : "") +
                (videoCount ? ` · ${videoCount} video${videoCount !== 1 ? "s" : ""}` : "")}
          </p>
        </div>
        <div className="claims-actions">
          <button className="btn-primary" type="button" onClick={() => setUploadOpen(true)}>
            Upload event media
          </button>
          <button className="btn-outline" type="button" onClick={openViewer} disabled={uploads.length === 0}>
            View event media
          </button>
          <button
            className="btn-outline"
            type="button"
            onClick={() => {
              openShare();
              setShareLink("");
              setShareExpires(null);
            }}
            disabled={uploads.length === 0}
          >
            Client links
          </button>
        </div>
      </div>

      {/* A contact sheet of the most recent files, so the panel isn't just two buttons */}
      {uploads.length > 0 && (
        <div className="panel-body">
          <div className="media-strip">
            {groups.map((g) => (
              <button
                key={g.folder || "__loose"}
                type="button"
                className="media-folder-chip"
                onClick={openViewer}
              >
                <span className="media-folder-name">{g.folder || "Loose files"}</span>
                <span className="media-folder-meta">
                  {g.records.length} file{g.records.length !== 1 ? "s" : ""} · {g.uploaders.join(", ") || "Unknown"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ---------------- Upload dialog ---------------- */}
      {uploadOpen && (
        <div className="modal-overlay" onClick={closeUpload}>
          <div className="modal-card media-modal" onClick={(e) => e.stopPropagation()}>
            <div className="claims-header">
              <h3>Upload event media</h3>
              <button className="link-button" type="button" onClick={closeUpload} disabled={busy}>Close</button>
            </div>

            <div
              className={`dropzone${dragging ? " dropzone-active" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                if (!busy) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <strong>Drop photos, videos, folders or a ZIP here</strong>
              <span className="muted">
                Folder structure is kept, and everything goes straight to secure storage. Large files upload in
                parts, so a dropped connection retries that part rather than starting over.
              </span>
              <div className="claims-actions" style={{ justifyContent: "center", marginTop: 4 }}>
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
              accept="image/*,video/*,.zip,.rar,.7z,.pdf,.doc,.docx,.xls,.xlsx"
              style={{ display: "none" }}
              onChange={(e) => {
                fromInput(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={folderRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                fromInput(e.target.files);
                e.target.value = "";
              }}
            />

            {items.length > 0 && (
              <div className="uploader-list">
                <div className="uploader-list-head">
                  <span>{items.length} file{items.length !== 1 ? "s" : ""} · {formatBytes(totalBytes)}</span>
                  <span>{items.filter((i) => i.status === "done").length} uploaded</span>
                </div>
                {items.map((item) => (
                  <div key={item.id} className={`uploader-row uploader-${item.status}`}>
                    <span className="uploader-name" title={item.path ? `${item.path}/${item.file.name}` : item.file.name}>
                      {item.path && <span className="uploader-path">{item.path}/</span>}
                      {item.file.name}
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
                        aria-label={`Remove ${item.file.name}`}
                        disabled={busy}
                        onClick={() => removeItem(item.id)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {notice && <div className="muted">{notice}</div>}

            <div className="modal-actions">
              <button className="btn-outline" type="button" onClick={closeUpload} disabled={busy}>
                {busy ? "Uploading…" : "Done"}
              </button>
              <button className="btn-primary" type="button" onClick={handleUpload} disabled={busy || pending.length === 0}>
                {busy ? "Uploading…" : `Upload ${pending.length || ""}`.trim()}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Viewer dialog ---------------- */}
      {viewerOpen && (
        /* Closing mid-download would hide the only Cancel button while the
           transfer carried on, so the viewer stays put until it is done. */
        <div className="modal-overlay" onClick={() => !zip && !saveQueue && setViewerOpen(false)}>
          <div className="modal-card media-modal media-viewer" onClick={(e) => e.stopPropagation()}>
            <div className="claims-header">
              <div>
                <h3>Event media</h3>
                <p className="muted">{uploads.length} file{uploads.length !== 1 ? "s" : ""} in secure storage</p>
              </div>
              <div className="claims-actions">
                {/* One archive where the browser can write to disk; the
                    one-at-a-time queue everywhere else. */}
                {zipReady ? (
                  zip ? (
                    <button className="btn-outline" type="button" onClick={() => zipAbort.current?.abort()}>
                      Cancel ZIP
                    </button>
                  ) : (
                    <button className="btn-outline" type="button" onClick={startZip} disabled={uploads.length === 0}>
                      Download all as ZIP
                    </button>
                  )
                ) : saveQueue ? (
                  <button className="btn-outline" type="button" onClick={() => saveAbort.current?.abort()}>
                    Stop
                  </button>
                ) : (
                  <button
                    className="btn-outline"
                    type="button"
                    onClick={() => void runQueueDownloads()}
                    disabled={uploads.length === 0}
                  >
                    Download all
                  </button>
                )}
                <button
                  className="link-button"
                  type="button"
                  onClick={() => setViewerOpen(false)}
                  disabled={!!zip || !!saveQueue}
                >
                  Close
                </button>
              </div>
            </div>

            {zip && (
              <div className="muted">
                Zipping {zip.filesDone} of {zip.filesTotal} · {formatBytes(zip.bytesWritten)} written
                {zip.skipped > 0 ? ` · ${zip.skipped} skipped` : ""}
                {zip.current ? ` · ${zip.current}` : ""}
                <br />
                Keep this tab open until it finishes.
              </div>
            )}
            {saveQueue && (
              <div className="muted">
                Saving {saveQueue.done} of {saveQueue.total}
                {saveQueue.failed > 0 ? ` · ${saveQueue.failed} failed` : ""}
                <br />
                Keep this tab open, and allow multiple downloads if your browser asks.
              </div>
            )}
            {zipNote && !zip && !saveQueue && <div className="muted">{zipNote}</div>}
            {!zipReady && !saveQueue && uploads.length > 0 && (
              <div className="muted">
                Download all saves the files one at a time. A single ZIP of the whole event needs Chrome or Edge on a
                computer.
              </div>
            )}

            {loadingMedia && <div className="muted">Preparing secure links…</div>}

            {groups.map((g) => {
              const open = openFolders[g.folder] !== false;
              return (
                <div key={g.folder || "__loose"} className="media-group">
                  <button
                    className="media-group-head"
                    type="button"
                    onClick={() => setOpenFolders((p) => ({ ...p, [g.folder]: !open }))}
                  >
                    <span className="media-group-name">{g.folder || "Loose files"}</span>
                    <span className="media-group-meta">
                      {g.records.length} file{g.records.length !== 1 ? "s" : ""} · uploaded by {g.uploaders.join(", ") || "Unknown"}
                    </span>
                  </button>

                  {open && (
                    <div className="photo-gallery">
                      {g.records.map((r) => {
                        const thumbUrl = derivativeUrlFor(r.fileUrl, "thumb");
                        const src = (thumbUrl && signed[thumbUrl]) || signed[r.fileUrl];
                        const name = displayNameFromFileUrl(r.fileUrl);
                        return (
                          <button
                            key={r.id}
                            type="button"
                            className="photo-thumb"
                            title={name}
                            onClick={() => setLightbox(r)}
                          >
                            {(isImage(r.fileType) || isVideo(r.fileType)) && src && (
                              <img
                                src={src}
                                alt={name}
                                loading="lazy"
                                onError={(e) => {
                                  // Pre-thumbnail uploads have no derivative to serve.
                                  const img = e.currentTarget;
                                  const full = signed[r.fileUrl];
                                  if (full && img.src !== full) img.src = full;
                                }}
                              />
                            )}
                            {isVideo(r.fileType) && (
                              <span className="media-play-badge" aria-hidden="true">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                              </span>
                            )}
                            {!isImage(r.fileType) && !isVideo(r.fileType) && (
                              <span className="media-badge-file">{(r.fileType.split("/")[1] || "file").slice(0, 4).toUpperCase()}</span>
                            )}
                            {isArchived(r.createdAt) && <span className="media-cold-chip">Archived</span>}
                            <div className="photo-thumb-info">
                              <span className="muted">{r.user?.name ?? "Unknown"}</span>
                              <span className="muted">{fmtDate(r.createdAt)}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ---------------- Client link dialog ---------------- */}
      {shareOpen && (
        <div className="modal-overlay" onClick={() => setShareOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="claims-header">
              <h3>Client links</h3>
              <button className="link-button" type="button" onClick={() => setShareOpen(false)}>Close</button>
            </div>

            {/* Existing links come first, so the reflex is to reuse rather than mint another */}
            {shares.length > 0 && (
              <div className="share-list">
                <div className="share-list-head">Active links</div>
                {shares.map((s) => {
                  const daysLeft = Math.max(0, Math.ceil((new Date(s.expiresAt).getTime() - Date.now()) / 86_400_000));
                  return (
                    <div key={s.id} className="share-row">
                      <div className="share-row-main">
                        <strong>{s.folder || "Whole event"}</strong>
                        <span className="muted">
                          {s.creator.name} · expires in {daysLeft} day{daysLeft !== 1 ? "s" : ""} ·{" "}
                          {s.viewCount === 0 ? "not opened yet" : `opened ${s.viewCount}×`}
                        </span>
                      </div>
                      <div className="share-row-actions">
                        <button className="edit-btn" type="button" onClick={() => copyExisting(s.token, s.id)}>
                          {copiedId === s.id ? "Copied" : "Copy"}
                        </button>
                        <button className="edit-btn" type="button" onClick={() => revokeShare(s.id)}>
                          Revoke
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <p className="muted">
              Anyone with the link can view and download this media. No sign-in, and nothing else about the
              event is shown.
            </p>

            <label className="auth-label" htmlFor="share-scope">What to share</label>
            <select
              id="share-scope"
              className="input select"
              value={shareFolder}
              onChange={(e) => {
                setShareFolder(e.target.value);
                setShareLink("");
              }}
            >
              <option value="">Everything in this event ({uploads.length} files)</option>
              {groups
                .filter((g) => g.folder)
                .map((g) => (
                  <option key={g.folder} value={g.folder}>
                    {g.folder} ({g.records.length} files)
                  </option>
                ))}
            </select>

            <label className="auth-label" htmlFor="share-days">Expires after</label>
            <select
              id="share-days"
              className="input select"
              value={shareDays}
              onChange={(e) => {
                setShareDays(Number(e.target.value));
                setShareLink("");
              }}
            >
              <option value={2}>2 days (minimum)</option>
              <option value={5}>5 days</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={21}>21 days</option>
              <option value={30}>30 days (maximum)</option>
            </select>
            <span className="cell-meta">Pick the shortest window the client actually needs.</span>

            {shareLink && (
              <>
                <label className="auth-label" htmlFor="share-link">Link</label>
                <input
                  id="share-link"
                  className="input share-link-field"
                  readOnly
                  value={shareLink}
                  onFocus={(e) => e.currentTarget.select()}
                />
                {shareExpires && (
                  <span className="cell-meta">
                    Stops working {new Date(shareExpires).toLocaleString("en-IN", {
                      day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true
                    })}. It cannot be revoked earlier, so share it carefully.
                  </span>
                )}
              </>
            )}

            <div className="modal-actions">
              {shareLink && (
                <button className="btn-outline" type="button" onClick={copyLink}>
                  {copied ? "Copied" : "Copy link"}
                </button>
              )}
              <button className="btn-primary" type="button" onClick={createShareLink} disabled={shareBusy}>
                {shareBusy ? "Creating…" : shareLink ? "Create a new link" : "Create link"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Lightbox ---------------- */}
      {lightbox && (
        <div className="modal-overlay" onClick={() => setLightbox(null)} style={{ zIndex: 90 }}>
          <div className="lightbox-container" onClick={(e) => e.stopPropagation()}>
            <button className="lightbox-close" type="button" onClick={() => setLightbox(null)} aria-label="Close">×</button>
            {isImage(lightbox.fileType) && (() => {
              const p = derivativeUrlFor(lightbox.fileUrl, "preview");
              const src = (p && signed[p]) || signed[lightbox.fileUrl];
              return src ? <img className="lightbox-img" src={src} alt={displayNameFromFileUrl(lightbox.fileUrl)} /> : null;
            })()}
            {isVideo(lightbox.fileType) && signed[lightbox.fileUrl] && (
              <video className="lightbox-img" src={signed[lightbox.fileUrl]} controls autoPlay />
            )}
            {!isImage(lightbox.fileType) && !isVideo(lightbox.fileType) && (
              <div className="panel" style={{ padding: 24, background: "var(--paper)" }}>
                <h3>{displayNameFromFileUrl(lightbox.fileUrl)}</h3>
                <p className="muted">Uploaded by {lightbox.user?.name ?? "Unknown"} · {fmtDate(lightbox.createdAt)}</p>
                {signed[lightbox.fileUrl] && (
                  <a className="btn-primary" style={{ marginTop: 12 }} href={signed[lightbox.fileUrl]} target="_blank" rel="noopener noreferrer">
                    Open file
                  </a>
                )}
              </div>
            )}
            <div className="lightbox-caption">
              {displayNameFromFileUrl(lightbox.fileUrl)} · {lightbox.user?.name ?? "Unknown"} · {fmtDate(lightbox.createdAt)}
              {isArchived(lightbox.createdAt) ? (
                <>
                  <br />
                  <span>
                    Original is in cold storage.{" "}
                    <button className="lightbox-link" type="button" onClick={() => requestOriginal(lightbox)}>
                      Request original
                    </button>
                    {restoreState[lightbox.id] ? ` — ${restoreState[lightbox.id]}` : " — ready in about 12 hours"}
                  </span>
                </>
              ) : (
                (() => {
                  const left = daysUntilArchived(lightbox.createdAt);
                  return left !== null && left <= 14 ? (
                    <>
                      <br />
                      <span>Moves to cold storage in {left} day{left !== 1 ? "s" : ""}</span>
                    </>
                  ) : null;
                })()
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
