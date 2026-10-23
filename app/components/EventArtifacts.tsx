"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  uploadFile,
  MULTIPART_THRESHOLD,
  isCancellation,
  waitUnlessCancelled
} from "../../lib/upload-client";
import {
  ARTIFACT_CATEGORY_LIST,
  isInlineImageType,
  isInlineViewableType,
  type ArtifactCategoryKey
} from "../../lib/event-artifacts";
import "./event-artifacts.css";

/* The working documents of an event — decks, flows, creatives, layouts, customer
 * data — as opposed to its media. Every employee sees and uploads; deletion is
 * confined to your own files, with the Managing Director able to delete anything.
 *
 * The server decides all of that: `canDelete` arrives per artifact and the
 * DELETE re-checks it, so this component never reasons about roles. It also
 * never touches the media endpoints — artifacts live in their own table under
 * their own key prefix (lib/event-artifacts.ts), which is what keeps a pitch
 * deck out of a client's gallery.
 */

type Artifact = {
  id: string;
  category: ArtifactCategoryKey;
  fileName: string;
  fileType: string;
  size: number | null;
  uploadedBy: { id: string; name: string };
  createdAt: string;
  canDelete: boolean;
};

type Category = { key: ArtifactCategoryKey; label: string };

type ItemStatus = "queued" | "uploading" | "done" | "error";

/* The bytes are in storage and only the row is missing, so what is left to do is
   ONE POST. Held on the item so pressing Upload again re-runs that POST with
   this exact body instead of starting the file over — see the comment on
   registerArtifact. */
type Pending = { fileUrl: string; fileType: string };

type Item = {
  id: string;
  file: File;
  /* Pinned when the file is picked, not read off the active tab at upload time:
     switching tabs mid-batch must not file the rest under another category. */
  category: ArtifactCategoryKey;
  status: ItemStatus;
  pct: number;
  error?: string;
  /** Set only when the upload landed and the registration did not. */
  pending?: Pending;
};

const UPLOAD_CONCURRENCY = 3;

/* Registration gets retries of its OWN, before the file-level ones, for the
   reason lib/media-upload.ts spells out at length: by this point the bytes are
   already in storage, so answering a failure by starting the file again uploads
   a 2 GB deck a second time under a second key and leaves the first object with
   no row — and nothing in this system can ever reclaim it (there is no
   ListObjectsV2 anywhere, UploadCharge rows are a photographer-quota mechanism
   employees never get, and the multipart janitor only aborts OPEN sessions).
   Retrying just the POST costs one request and cannot double-register: the route
   is idempotent on (eventId, fileUrl) and hands back the row it already has.

   Four goes, matching registerUpload's REGISTER_ATTEMPTS, because this endpoint
   answers 503 whenever the HEAD on storage fails for any reason other than a
   404 — which is every artifact while R2 is returning NotEntitled. */
const REGISTER_ATTEMPTS = 4;
const REGISTER_BACKOFF_MS = [1_000, 4_000, 10_000];

/* Statuses worth asking again: no answer at all, a timeout, a throttle, or any
   5xx. Everything else is a decision about this request that will be made
   identically next time. By STATUS, never by matching the server's prose. */
const retryableRegisterStatus = (status: number) =>
  status === 0 || status === 408 || status === 429 || status >= 500;

/**
 * The outstanding registration a failed upload left behind, or null when the
 * bytes themselves are no good and the file has to be sent again.
 *
 * 422 is the route saying storage does not have the object (a HEAD 404) and 409
 * that the row was deleted under us — in both cases there is nothing in storage
 * to record, so the pending registration is dropped and a retry re-uploads.
 */
class RegisterFailed extends Error {
  readonly pending: Pending | null;

  constructor(message: string, pending: Pending | null) {
    super(message);
    this.name = "RegisterFailed";
    this.pending = pending;
  }
}

/* A thumbnail costs one signed-URL round trip per file, so it is only worth it
   where the picture IS the content. Decks and spreadsheets get their type chip. */
const THUMBNAIL_CATEGORIES: readonly ArtifactCategoryKey[] = ["CREATIVES", "LAYOUTS"];

const formatBytes = (n: number | null) => {
  if (n === null) return "—";
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

/* Which types get a View button and which get a thumbnail is the SERVER's
   allow-list (lib/event-artifacts.ts), not a second opinion formed here: the
   URL endpoint signs `inline` for those types and an attachment for everything
   else, so asking the same question keeps the button from opening a tab that
   immediately saves a file — and keeps an <img> from pointing at a URL that was
   signed as a download. */

/* The chip on the left of each row. Taken from the file name rather than the
   MIME type: "application/vnd.openxmlformats-…presentationml.presentation" says
   nothing at a glance, "PPTX" does. */
const extensionOf = (fileName: string) => {
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1) : "";
  return (ext || "file").slice(0, 4).toUpperCase();
};

/* The server's message is the useful one ("You can only delete files you
   uploaded"), so every failure path reads it before falling back. */
const messageFrom = async (res: Response, fallback: string) => {
  const said = await res.json().catch(() => null);
  return typeof said?.error === "string" && said.error ? said.error : fallback;
};

/**
 * Records a file whose bytes are already in storage, with retries of its own.
 *
 * Also the whole of "retry" for an item that failed HERE: called again with the
 * same body, it re-runs the one step that did not finish. Safe to call twice —
 * registration is idempotent on (eventId, fileUrl).
 */
const registerArtifact = async (
  eventId: string,
  body: { category: ArtifactCategoryKey; fileUrl: string; fileName: string; fileType: string }
): Promise<Artifact> => {
  const pending: Pending = { fileUrl: body.fileUrl, fileType: body.fileType };

  for (let attempt = 1; ; attempt += 1) {
    let status = 0;
    let message = "Uploaded, but could not be recorded";
    try {
      const res = await fetch(`/api/events/${eventId}/artifacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (res.ok) return (await res.json()) as Artifact;
      status = res.status;
      message = await messageFrom(res, message);
    } catch {
      /* fetch rejects, with a bare per-browser TypeError, when the request never
         reached Velocity at all. Status 0 so it is classified by number like
         everything else rather than by prose. */
      status = 0;
    }

    /* 422 (storage does not have the object) and 409 (the row was deleted) are
       the only answers that mean the bytes are no good; everything else leaves
       the registration retryable on its own. */
    const bytesUsable = status !== 422 && status !== 409;

    if (attempt >= REGISTER_ATTEMPTS || !retryableRegisterStatus(status)) {
      throw new RegisterFailed(message, bytesUsable ? pending : null);
    }
    await waitUnlessCancelled(REGISTER_BACKOFF_MS[Math.min(attempt, REGISTER_BACKOFF_MS.length) - 1]);
  }
};

export default function EventArtifacts({ eventId }: { eventId: string }) {
  const [categories, setCategories] = useState<Category[]>(ARTIFACT_CATEGORY_LIST);
  const [active, setActive] = useState<ArtifactCategoryKey>(ARTIFACT_CATEGORY_LIST[0].key);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);

  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Artifact | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  /* Which thumbnails have already been asked for, successfully or not. In a ref
     rather than state so a failed signature does not re-request on every
     render — the effect reads it without depending on it. */
  const thumbAsked = useRef<Set<string>>(new Set());
  /* Requests still outstanding, so a re-render (or a tab switch and back) does
     not ask for the same signature twice before the first answer lands. */
  const thumbInFlight = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/artifacts`);
      if (!res.ok) {
        setLoadError(await messageFrom(res, "Could not load event artifacts."));
        return;
      }
      const data = await res.json();
      if (Array.isArray(data.categories) && data.categories.length > 0) setCategories(data.categories);
      setArtifacts(Array.isArray(data.artifacts) ? data.artifacts : []);
      setLoadError("");
    } catch {
      setLoadError("Could not load event artifacts. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const inCategory = artifacts.filter((a) => a.category === active);
  /* EVERY queued file, not just the active tab's. handleUpload sends them all —
     each one under the category it was dropped on — so filtering this list by
     tab hid files that were still going to be uploaded and took the Upload
     button away with them: queue three decks under PPT, switch to Creatives, and
     both the queue and the button vanished while the files sat in state. Each
     row names its own category instead. */
  const queued = items;
  const countOf = (key: ArtifactCategoryKey) => artifacts.filter((a) => a.category === key).length;
  const labelOf = (key: ArtifactCategoryKey) => categories.find((c) => c.key === key)?.label ?? key;

  /* Thumbnails for the category on screen, one request each.
     `thumbAsked` is marked when a request SETTLES, not when it is started, and
     nothing discards a response that arrives after the tab changed: marking up
     front and dropping late results meant switching tabs mid-load left those
     rows showing their extension chip for the rest of the session, because the
     id was already recorded as asked. A URL that arrives for a tab nobody is
     looking at costs one key in state and paints correctly on the way back. */
  useEffect(() => {
    if (!THUMBNAIL_CATEGORIES.includes(active)) return;
    const wanted = artifacts.filter(
      (a) =>
        a.category === active &&
        isInlineImageType(a.fileType) &&
        !thumbAsked.current.has(a.id) &&
        !thumbInFlight.current.has(a.id)
    );
    if (wanted.length === 0) return;
    for (const a of wanted) thumbInFlight.current.add(a.id);
    void Promise.all(
      wanted.map(async (a) => {
        try {
          const res = await fetch(`/api/events/${eventId}/artifacts/${a.id}/url?mode=view`);
          if (res.ok) {
            const { url } = await res.json();
            if (typeof url === "string") setThumbs((prev) => ({ ...prev, [a.id]: url }));
          }
          thumbAsked.current.add(a.id);
        } catch {
          /* The row falls back to its type chip. Left unmarked so a connection
             that comes back is allowed to try again. */
        } finally {
          thumbInFlight.current.delete(a.id);
        }
      })
    );
  }, [active, artifacts, eventId]);

  /* ---- picking files ---- */
  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    setNotice("");
    setItems((prev) => [
      ...prev,
      ...files.map((file, i) => ({
        id: `${Date.now()}-${prev.length + i}-${file.name}`,
        file,
        category: active,
        status: "queued" as ItemStatus,
        pct: 0
      }))
    ]);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    // Plain files only: an artifact has a category, not a folder structure.
    addFiles(Array.from(e.dataTransfer.files));
  };

  const patch = (id: string, next: Partial<Item>) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...next } : i)));

  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id));

  /* ---- the upload run ----
     Failures stay in the list as "error" so pressing Upload again retries only
     those — the same contract EventMedia's uploader has. */
  const handleUpload = async () => {
    const pending = items.filter((i) => i.status === "queued" || i.status === "error");
    if (pending.length === 0) {
      setNotice("Add files first.");
      return;
    }
    setBusy(true);
    setNotice("");

    const queue = [...pending];
    let failures = 0;
    const landed: Artifact[] = [];

    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        /* A retry of a landed-but-unregistered file starts at 100: its bytes are
           already in storage and the bar must not appear to go backwards. */
        patch(item.id, { status: "uploading", pct: item.pending ? 100 : 0, error: undefined });
        try {
          /* The ONE step that is left when a previous attempt uploaded the file
             and could not record it. Skipping back to presign here would mint a
             new key, re-send every byte, and abandon the object already in
             storage with no row and nothing to reclaim it. */
          let landedUrl = item.pending?.fileUrl;
          const fileType = item.pending?.fileType ?? contentTypeOf(item.file);

          if (!landedUrl) {
            const presignRes = await fetch(`/api/events/${eventId}/artifacts/presign`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                category: item.category,
                fileName: item.file.name,
                fileType,
                fileSize: item.file.size
              })
            });
            if (!presignRes.ok) throw new Error(await messageFrom(presignRes, "Could not get an upload link"));
            const { uploadUrl, fileUrl: slotUrl, reservation } = await presignRes.json();

            /* Under 16MB this is the single signed PUT; above it uploadFile goes
               to /api/uploads/multipart, and `reservation` is what makes the
               parts land on the key presign already minted rather than a fresh
               one. relativePath is empty because artifact keys carry their
               category instead of a folder. */
            landedUrl = await uploadFile(
              item.file,
              {
                eventId,
                relativePath: "",
                purpose: "media",
                presignedUrl: uploadUrl,
                fileUrl: slotUrl,
                reservation
              },
              /* Guarded because a 0-byte file (an empty template, an empty CSV
                 export — both of which presign now accepts) makes the progress
                 arithmetic 0/0, and "NaN%" in the row is a worse answer than
                 nothing. */
              (pct) => patch(item.id, { pct: Number.isFinite(pct) ? pct : 0 })
            );
          }

          landed.push(
            await registerArtifact(eventId, {
              category: item.category,
              fileUrl: landedUrl,
              fileName: item.file.name,
              fileType
            })
          );

          patch(item.id, { status: "done", pct: 100, pending: undefined });
        } catch (err) {
          failures += 1;
          /* A registration that failed for good carries what is still owed, so
             the row keeps it and the next Upload press is one POST. Anything
             else clears it: the bytes are not in storage (or are no longer
             usable) and the file has to be sent again. */
          const owed = err instanceof RegisterFailed ? err.pending : null;
          const said =
            err instanceof Error && err.message ? err.message : "Upload failed";
          patch(item.id, {
            status: "error",
            pending: owed ?? undefined,
            error: isCancellation(err)
              ? "Cancelled"
              : owed
                ? `${said} — press Upload to save it; the file won't be sent again.`
                : said
          });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker));

    /* Registered rows are merged straight in — newest first, as the list is
       ordered — so the panel updates without a second round trip. Keyed by id so
       a retry that found an existing row (registration is idempotent) does not
       double up. */
    if (landed.length > 0) {
      setArtifacts((prev) => {
        const seen = new Set(landed.map((a) => a.id));
        return [...landed, ...prev.filter((a) => !seen.has(a.id))];
      });
    }

    setBusy(false);
    const ok = pending.length - failures;
    setNotice(
      failures === 0
        ? `${ok} file${ok !== 1 ? "s" : ""} uploaded.`
        : `${ok} uploaded, ${failures} failed. Press Upload again to retry the failures.`
    );
    // Successes are cleared so the list is only ever what still needs doing.
    setItems((prev) => prev.filter((i) => i.status !== "done"));
  };

  /* ---- opening a file ----
     Buckets are private, so every read is a signed URL minted on demand. */
  const open = async (artifact: Artifact, mode: "view" | "download") => {
    setOpening(artifact.id);
    try {
      const res = await fetch(`/api/events/${eventId}/artifacts/${artifact.id}/url?mode=${mode}`);
      if (!res.ok) {
        setNotice(await messageFrom(res, "Could not open that file."));
        return;
      }
      const { url } = await res.json();
      /* Both in a new tab. The download URL carries
         Content-Disposition: attachment, so that tab saves the file and closes
         itself rather than navigating away from the event. */
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setNotice("Could not open that file. Check your connection and try again.");
    } finally {
      setOpening(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/events/${eventId}/artifacts/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        setDeleteError(await messageFrom(res, "Could not delete that file."));
        return;
      }
      setArtifacts((prev) => prev.filter((a) => a.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch {
      setDeleteError("Could not delete that file. Check your connection and try again.");
    } finally {
      setDeleting(false);
    }
  };

  const activeLabel = categories.find((c) => c.key === active)?.label ?? active;

  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-header claims-header">
        <div>
          <h2>Event Artifacts</h2>
          <p className="muted">
            Decks, flows, creatives, layouts and customer data for this event. Everyone on the team can see and
            upload; you can delete your own files.
          </p>
        </div>
      </div>

      <div className="panel-body">
        <div className="ea-tabs" role="tablist" aria-label="Artifact categories">
          {categories.map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={c.key === active}
              className={`ea-tab${c.key === active ? " ea-tab-active" : ""}`}
              onClick={() => setActive(c.key)}
            >
              {c.label}
              <span className="ea-tab-count">{countOf(c.key)}</span>
            </button>
          ))}
        </div>

        {loadError && (
          <p className="auth-error" role="alert">
            {loadError}
          </p>
        )}

        <div
          className={`dropzone ea-dropzone${dragging ? " dropzone-active" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <strong>Drop files here to add them to {activeLabel}</strong>
          <span className="muted">
            Any number of files, any type. Large files upload in parts, so a dropped connection retries that part
            rather than starting over.
          </span>
          <div className="claims-actions" style={{ justifyContent: "center", marginTop: 4 }}>
            <button className="btn-outline" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
              Upload files
            </button>
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />

        {queued.length > 0 && (
          <>
          <div className="uploader-list">
            <div className="uploader-list-head">
              <span>
                {queued.length} file{queued.length !== 1 ? "s" : ""} to upload
              </span>
              <span>{formatBytes(queued.reduce((s, i) => s + i.file.size, 0))}</span>
            </div>
            {queued.map((item) => (
              <div key={item.id} className={`uploader-row uploader-${item.status}`}>
                {/* The chip rides inside the name cell on purpose: .uploader-row
                    is a four-column grid shared with the other uploaders, and a
                    fifth child would shift every one of their rows. */}
                <span className="uploader-name" title={`${item.file.name} · ${labelOf(item.category)}`}>
                  <span className="ea-queue-cat">{labelOf(item.category)}</span>
                  {item.file.name}
                </span>
                <span className="uploader-size">
                  {formatBytes(item.file.size)}
                  {item.file.size > MULTIPART_THRESHOLD && <span className="uploader-parts"> · in parts</span>}
                </span>
                {/* titled because a failure's full sentence is wider than the
                    cell: .uploader-error .uploader-state ellipsises at 190px. */}
                <span className="uploader-state" title={item.error ?? undefined}>
                  {item.status === "queued" && "Queued"}
                  {item.status === "uploading" && `${item.pct}%`}
                  {item.status === "done" && "Uploaded"}
                  {item.status === "error" && (item.error ?? "Failed")}
                </span>
                {item.status === "uploading" ? (
                  <span className="uploader-bar">
                    <span style={{ width: `${item.pct}%` }} />
                  </span>
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
          {/* Outside the list: it scrolls past 260px, and the button that starts
              the batch must not scroll away with it. */}
          <div className="ea-queue-actions">
            <button className="btn-primary" type="button" onClick={handleUpload} disabled={busy}>
              {busy ? "Uploading…" : "Upload"}
            </button>
          </div>
          </>
        )}

        {notice && <p className="muted ea-notice">{notice}</p>}

        {loading ? (
          <p className="muted">Loading artifacts…</p>
        ) : inCategory.length === 0 ? (
          <div className="empty-state">No {activeLabel.toLowerCase()} files yet.</div>
        ) : (
          <ul className="ea-list">
            {inCategory.map((a) => {
              const thumb = thumbs[a.id];
              return (
                <li key={a.id} className="ea-row">
                  <span className="ea-icon" aria-hidden="true">
                    {thumb ? (
                      /* A signed URL lives ten minutes, so one held across a long
                         sitting eventually 403s. Dropping it here — from the map
                         and from `thumbAsked` — is what lets the effect mint a
                         fresh one instead of leaving a broken image. */
                      <img
                        src={thumb}
                        alt=""
                        loading="lazy"
                        onError={() => {
                          thumbAsked.current.delete(a.id);
                          setThumbs((prev) => {
                            const next = { ...prev };
                            delete next[a.id];
                            return next;
                          });
                        }}
                      />
                    ) : (
                      <span className="ea-ext">{extensionOf(a.fileName)}</span>
                    )}
                  </span>
                  <span className="ea-main">
                    <span className="ea-name" title={a.fileName}>
                      {a.fileName}
                    </span>
                    <span className="ea-meta">
                      {formatBytes(a.size)} · {a.uploadedBy.name} · {fmtDate(a.createdAt)}
                    </span>
                  </span>
                  <span className="ea-actions">
                    {isInlineViewableType(a.fileType) && (
                      <button
                        className="edit-btn"
                        type="button"
                        disabled={opening === a.id}
                        onClick={() => open(a, "view")}
                      >
                        View
                      </button>
                    )}
                    <button
                      className="edit-btn"
                      type="button"
                      disabled={opening === a.id}
                      onClick={() => open(a, "download")}
                    >
                      Download
                    </button>
                    {a.canDelete && (
                      <button
                        className="edit-btn ea-delete"
                        type="button"
                        onClick={() => {
                          setDeleteError("");
                          setDeleteTarget(a);
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Deletion removes the object from storage as well as hiding the row, so
          it is confirmed rather than fired straight off the list. Backdrop
          dismiss is off while the request is in flight: closing mid-delete would
          hide the outcome, the server's refusal included. */}
      {deleteTarget && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            if (!deleting) setDeleteTarget(null);
          }}
        >
          <div className="modal-card" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3>Delete file</h3>
            <p>Delete {deleteTarget.fileName}? This removes the file for everyone.</p>
            {deleteError && (
              <p className="auth-error" role="alert">
                {deleteError}
              </p>
            )}
            <div className="modal-actions">
              <button
                className="btn-outline hover-text"
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={confirmDelete}
                disabled={deleting}
                style={{ background: "var(--red)" }}
              >
                {deleting ? "Deleting…" : "Delete file"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
