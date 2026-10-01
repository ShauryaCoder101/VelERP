"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { MULTIPART_THRESHOLD } from "../../../lib/upload-client";
import { isQuotaError, notifyUploadBatch, QUOTA_MESSAGE, uploadMediaFile } from "../../../lib/media-upload";
import { markAsDirectoryInput, readDataTransfer, readFileInput, type DroppedFile } from "../../../lib/file-drop";
import FolderPicker from "../../components/FolderPicker";
import "./upload.css";

type EventOption = {
  id: string;
  eventName: string;
  companyName: string;
  fromDate: string;
  toDate: string;
};

type Quota = { usedBytes: number; quotaBytes: number };

/* GET /api/media-folders. uploadRoot and viewRoot are the same string for the
   firm's main login — the firm folder is both what it may fill and what it may
   see — but the endpoint reports them separately because a contributor's are
   not, so only uploadRoot is read here. */
type FolderPayload = { uploadRoot: string | null; viewRoot: string | null; folders: string[] };

type ItemStatus = "queued" | "uploading" | "done" | "error";

type Item = {
  id: string;
  file: File;
  /** Folder portion only ("Day 1/Stage"); empty for loose files. */
  path: string;
  status: ItemStatus;
  pct: number;
  error?: string;
};

/* Storage is billed in decimal units and the quota is a round 1 TB, so the
   allowance is shown in decimal too — a photographer told "931 GiB of 1 TB"
   would reasonably think the numbers were wrong. */
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

export default function PhotographerUploadPage() {
  const [events, setEvents] = useState<EventOption[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [eventId, setEventId] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [blocked, setBlocked] = useState("");

  /* Where in the firm's folder this batch lands. `target` is relative to
     uploadRoot, "" meaning the firm folder itself — the loose-files case. */
  const [uploadRoot, setUploadRoot] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [foldersError, setFoldersError] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => markAsDirectoryInput(folderRef.current), []);

  /* Only the events an employee has explicitly handed over — a photographer
     must never see the rest of the calendar. */
  const loadAccess = async (): Promise<void> => {
    const res = await fetch("/api/photographer/events");
    if (!res.ok) {
      const said = await res.json().catch(() => null);
      throw new Error(said?.error || "Could not load your events");
    }
    const data: { events: EventOption[]; quota: Quota } = await res.json();
    setEvents(data.events);
    setQuota(data.quota);
    // One event is the normal case; preselecting it removes a pointless step.
    setEventId((prev) => (prev && data.events.some((e) => e.id === prev) ? prev : (data.events[0]?.id ?? "")));
  };

  useEffect(() => {
    loadAccess()
      .catch((err) => setNotice(err instanceof Error ? err.message : "Could not load your events"))
      .finally(() => setLoaded(true));
  }, []);

  /* The folder tree belongs to the event, so it is reloaded whenever the event
     changes — and the chosen target is dropped with it, because a folder in one
     event means nothing in another. */
  const loadFolders = useCallback(async (): Promise<void> => {
    if (!eventId) {
      setFolders([]);
      setUploadRoot("");
      return;
    }
    const res = await fetch(`/api/media-folders?eventId=${encodeURIComponent(eventId)}`);
    if (!res.ok) {
      const said = await res.json().catch(() => null);
      throw new Error(said?.error || "Your folders could not be loaded");
    }
    const data: FolderPayload = await res.json();
    setFolders(data.folders);
    setUploadRoot(data.uploadRoot ?? "");
  }, [eventId]);

  useEffect(() => {
    setTarget("");
    setFoldersError("");
    loadFolders().catch((err) =>
      setFoldersError(err instanceof Error ? err.message : "Your folders could not be loaded")
    );
  }, [loadFolders]);

  /* Creating a folder is the one write this page makes outside an upload. The
     picker wants back the new path relative to uploadRoot, and the row it
     created has to appear in the tree, so the list is refreshed alongside. */
  const createFolder = async (parentRelative: string, name: string): Promise<string> => {
    const res = await fetch("/api/media-folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, parent: parentRelative, name })
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || "The folder could not be created.");
    await loadFolders().catch(() => {});
    return body.relative as string;
  };

  const totalBytes = useMemo(() => items.reduce((s, i) => s + i.file.size, 0), [items]);
  const pending = items.filter((i) => i.status === "queued" || i.status === "error");
  const doneCount = items.filter((i) => i.status === "done").length;

  const usedPct = quota && quota.quotaBytes > 0 ? Math.min(100, (quota.usedBytes / quota.quotaBytes) * 100) : 0;

  const addFiles = (incoming: DroppedFile[]) => {
    if (incoming.length === 0) return;
    setNotice("");
    setBlocked("");
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

  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id));

  const patch = (id: string, next: Partial<Item>) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...next } : i)));

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    addFiles(await readDataTransfer(e.dataTransfer));
  };

  /**
   * One file, end to end. Throws; the caller decides whether to stop.
   * Resolves with the number of derivatives (thumb/preview) that did not land —
   * never fatal, but the caller reports it rather than letting blank tiles be
   * the first anyone hears of it.
   *
   * The pipeline itself lives in lib/media-upload.ts, shared with the public
   * open-link page. The path sent is relative to this firm's own folder: the
   * server prepends the root. A dropped directory structure nests UNDER the
   * chosen target rather than replacing it, so "Day 1/Stage" dropped into
   * "Gujarat" lands in "Gujarat/Day 1/Stage".
   */
  const uploadOne = async (item: Item) => {
    const { derivativeFailures } = await uploadMediaFile({
      file: item.file,
      eventId,
      relativePath: [target, item.path].filter(Boolean).join("/"),
      onProgress: (pct) => patch(item.id, { pct })
    });
    return derivativeFailures;
  };

  const handleUpload = async () => {
    if (!eventId) {
      setNotice("Choose the event these files belong to.");
      return;
    }
    if (pending.length === 0) {
      setNotice("Add photos, videos or a folder first.");
      return;
    }

    setBusy(true);
    setNotice("");
    setBlocked("");

    const queue = [...pending];
    const batchBytes = queue.reduce((sum, i) => sum + i.file.size, 0);
    let failures = 0;
    let stopped = 0;
    /* The server's own words for why the batch stopped. There is more than one
       reason now — the 1 TB allowance, or one of the in-progress ceilings —
       and only the server knows which, so the message is carried rather than
       reconstructed. */
    let stoppedBecause = "";
    let thumbFailures = 0;

    /* Fire-and-forget: the upload must not wait on an email server. */
    const notify = (phase: "start" | "end", failed = 0) =>
      notifyUploadBatch({ eventId, phase, fileCount: queue.length, totalBytes: batchBytes, failed });

    void notify("start");

    // One bad file must not strand the rest of the shoot.
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index];
      patch(item.id, { status: "uploading", pct: 0, error: undefined });
      try {
        thumbFailures += await uploadOne(item);
        patch(item.id, { status: "done", pct: 100 });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        patch(item.id, { status: "error", error: message });
        failures += 1;

        /* A full allowance, or a ceiling on uploads already in progress, is not
           a per-file problem: every remaining file would fail the same way, so
           the batch stops and says so once. */
        if (isQuotaError(err)) {
          stopped = queue.length - index - 1;
          stoppedBecause = message;
          for (const rest of queue.slice(index + 1)) patch(rest.id, { status: "queued", pct: 0 });
          break;
        }
      }
    }

    setBusy(false);
    void notify("end", failures);

    // The allowance moved, whether or not the files landed.
    await loadAccess().catch(() => {});
    // Dropped directories make folders too; the tree should show them.
    await loadFolders().catch(() => {});

    if (stopped > 0) {
      /* "The allowance is full" is only one of the reasons the batch stops now,
         and it is the one that needs a human: the in-progress ceilings clear
         themselves in minutes, so telling someone to ring Velocity about one
         would be wrong. The server distinguishes them, so its message is shown
         verbatim and only the queue count is added. */
      const waiting = `${stopped} file${stopped !== 1 ? "s are" : " is"} still queued.`;
      setBlocked(
        stoppedBecause.startsWith(QUOTA_MESSAGE)
          ? `Your 1 TB storage allowance is full, so the upload stopped — ${waiting} Ask your Velocity contact to free up room before trying again.`
          : `${stoppedBecause} The upload stopped, so ${waiting}`
      );
      return;
    }

    const ok = queue.length - failures;
    setNotice(
      (failures === 0
        ? `${ok} file${ok !== 1 ? "s" : ""} uploaded.`
        : `${ok} uploaded, ${failures} failed. Press Upload again to retry the failures.`) +
        (thumbFailures > 0
          ? ` ${thumbFailures} preview image${thumbFailures !== 1 ? "s" : ""} could not be saved — those files are safely stored, but their tiles will load the full version.`
          : "")
    );
  };

  const selectedEvent = events.find((e) => e.id === eventId);

  return (
    <>
      <div className="page-header">
        <h1>Upload event media</h1>
        <p>Photos and video go straight to Velocity&apos;s secure storage.</p>
      </div>

      <div className="upload-form">
        {quota && (
          <div className={`quota${usedPct >= 80 ? " quota-tight" : ""}`}>
            <div className="quota-line">
              <span>Storage used</span>
              <span className="quota-figure">
                {formatAllowance(quota.usedBytes)} of {formatAllowance(quota.quotaBytes)}
              </span>
            </div>
            <div
              className="quota-bar"
              role="progressbar"
              aria-label="Storage allowance used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(usedPct)}
            >
              <span style={{ width: `${usedPct}%` }} />
            </div>
          </div>
        )}

        {loaded && events.length === 0 ? (
          <div className="upload-empty">
            <strong>No events yet</strong>
            <span className="muted">
              You haven&apos;t been given access to any events yet. Ask your Velocity contact to add you to an
              event.
            </span>
          </div>
        ) : (
          <>
            <label className="auth-label" htmlFor="photo-event">Event</label>
            <select
              id="photo-event"
              className="input select"
              value={eventId}
              disabled={busy || !loaded}
              onChange={(e) => setEventId(e.target.value)}
            >
              <option value="">Choose an event</option>
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.eventName} — {e.companyName}
                </option>
              ))}
            </select>
            {selectedEvent && <span className="cell-meta">Filing under {selectedEvent.companyName}</span>}

            {/* Everything this firm sends lands inside its own folder; this
                chooses where inside it. The root is the loose-files case, and
                is deliberately the default — picking a folder is a decision,
                not a toll. */}
            {eventId && uploadRoot && (
              <>
                <span className="auth-label">Folder</span>
                <FolderPicker
                  folders={folders}
                  uploadRoot={uploadRoot}
                  value={target}
                  onChange={setTarget}
                  onCreate={createFolder}
                  rootLabel={uploadRoot}
                  disabled={busy}
                />
              </>
            )}
            {foldersError && <div className="auth-error" role="alert">{foldersError}</div>}

            {/* Uploading is only half the job: the same events can be browsed —
                every file on them, not just this photographer's — and shared
                with a client from there. Listed per event rather than hung off
                the dropdown, so the way through is visible without first
                choosing something. */}
            {/* Held back until the list has actually arrived: rendering the frame first
                put an empty bordered box on screen on every load. */}
            {loaded && events.length > 0 && (
            <div className="share-list">
              <div className="share-list-head">Your events</div>
              {/* The other half of this account: handing a password-less upload
                  URL to a photographer in the field who has no login at all.
                  Kept at the top of the event list because it is reached far
                  more often than any one event. */}
              <div className="share-row">
                <div className="share-row-main">
                  <strong>Upload links</strong>
                  <span className="muted">
                    Let your team upload to an event without a login, into your folder.
                  </span>
                </div>
                <div className="share-row-actions">
                  <Link className="edit-btn" href="/tpp-login/links">Open</Link>
                </div>
              </div>
              {events.map((option) => (
                <div key={option.id} className="share-row">
                  <div className="share-row-main">
                    <strong>{option.eventName}</strong>
                    <span className="muted">{option.companyName}</span>
                  </div>
                  <div className="share-row-actions">
                    <Link className="edit-btn" href={`/tpp-login/media/${option.id}`}>
                      View photos &amp; client links
                    </Link>
                  </div>
                </div>
              ))}
            </div>
            )}

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
                Folder names are kept, so &ldquo;Day 1/Stage&rdquo; stays as you delivered it. Large files upload in
                parts, and a dropped connection retries that part rather than starting over.
              </span>
              <div className="upload-actions">
                <button className="btn-outline" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
                  Select files
                </button>
                <button
                  className="btn-outline"
                  type="button"
                  disabled={busy}
                  onClick={() => folderRef.current?.click()}
                >
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
          </>
        )}

        {items.length > 0 && (
          <div className="uploader-list">
            <div className="uploader-list-head">
              <span>{items.length} file{items.length !== 1 ? "s" : ""} · {formatBytes(totalBytes)}</span>
              {doneCount > 0 && <span>{doneCount} uploaded</span>}
            </div>
            {items.map((item) => (
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

        {blocked && <div className="auth-error" role="alert">{blocked}</div>}
        {notice && <div className="muted">{notice}</div>}

        {events.length > 0 && (
          <button className="btn-primary auth-submit" type="button" onClick={handleUpload} disabled={busy}>
            {busy
              ? "Uploading…"
              : pending.length > 0
                ? `Upload ${pending.length} file${pending.length !== 1 ? "s" : ""}`
                : "Upload"}
          </button>
        )}
      </div>
    </>
  );
}
