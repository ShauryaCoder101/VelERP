"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { uploadFile, MULTIPART_THRESHOLD } from "../../../lib/upload-client";
import { makeDerivatives } from "../../../lib/derivatives";
import { markAsDirectoryInput, readDataTransfer, readFileInput, type DroppedFile } from "../../../lib/file-drop";
import "./upload.css";

type EventOption = {
  id: string;
  eventName: string;
  companyName: string;
  fromDate: string;
  toDate: string;
};

type Quota = { usedBytes: number; quotaBytes: number };

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

/* The browser must send exactly the Content-Type the URL was signed for,
   or storage rejects the PUT. Some cameras hand us files with an empty type,
   so both sides agree on this fallback. */
const contentTypeOf = (file: File) => file.type || "application/octet-stream";

const QUOTA_MESSAGE = "Upload limit reached";

const isQuotaError = (message: string) => message.startsWith(QUOTA_MESSAGE);

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
   */
  const uploadOne = async (item: Item) => {
    /* Shrink first, in the browser: the presign call has to declare the exact
       size of every slot it asks for, including the derivatives, because those
       URLs carry a signed Content-Length. */
    const small = await makeDerivatives(item.file);
    const wanted = (["thumb", "preview"] as const).filter((kind) => small[kind]);

    const presignRes = await fetch("/api/uploads/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId,
        fileName: item.file.name,
        fileType: contentTypeOf(item.file),
        relativePath: item.path,
        purpose: "media",
        fileSize: item.file.size,
        derivatives: wanted,
        derivativeSizes: Object.fromEntries(wanted.map((kind) => [kind, small[kind]!.size]))
      })
    });
    if (!presignRes.ok) {
      const said = await presignRes.json().catch(() => null);
      throw new Error(said?.error || "Could not get an upload link");
    }
    const {
      uploadUrl,
      fileUrl: simpleUrl,
      reservation,
      derivatives
    }: {
      uploadUrl?: string;
      fileUrl?: string;
      reservation?: string;
      derivatives?: Record<string, { uploadUrl: string; fileUrl: string }>;
    } = await presignRes.json();

    /* The derivatives go up FIRST, before the original.
       Their PUT URLs were just signed with a one-hour life, and a multi-GB
       video uploaded in parts routinely takes longer than that — sending them
       afterwards, as this used to, meant storage answered 403 and the gallery
       tile stayed blank forever. They are a few hundred KB, so going first
       costs nothing.
       Still best effort: a missing thumbnail only means the gallery falls back
       to the original and must not fail the file. But it is counted and logged
       rather than swallowed, so a systematic failure is visible. */
    let derivativeFailures = 0;
    await Promise.all(
      wanted.map(async (kind) => {
        const slot = derivatives?.[kind];
        if (!slot) return;
        try {
          const res = await fetch(slot.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": "image/jpeg" },
            body: small[kind]!
          });
          if (!res.ok) throw new Error(`storage returned ${res.status}`);
        } catch (err) {
          derivativeFailures += 1;
          console.warn(`Could not upload the ${kind} for ${item.file.name}`, err);
        }
      })
    );

    /* Anything large comes back without a single-PUT slot and goes up in parts,
       so a dropped connection costs one chunk rather than the whole file.

       The reservation goes with it: presign already signed the thumb and
       preview slots against one key, and the multipart route has to write the
       original to that same key or the derivatives below belong to nothing. */
    const fileUrl = await uploadFile(
      item.file,
      {
        eventId,
        relativePath: item.path,
        purpose: "media",
        presignedUrl: uploadUrl,
        fileUrl: simpleUrl,
        reservation
      },
      (pct) => patch(item.id, { pct })
    );

    const recordRes = await fetch("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, fileUrl, fileType: contentTypeOf(item.file) })
    });
    if (!recordRes.ok) {
      const said = await recordRes.json().catch(() => null);
      throw new Error(said?.error || "Uploaded, but could not be recorded");
    }

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
    let thumbFailures = 0;

    /* Fire-and-forget: the upload must not wait on an email server. */
    const notify = (phase: "start" | "end", failed = 0) =>
      fetch("/api/uploads/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, phase, fileCount: queue.length, totalBytes: batchBytes, failed })
      }).catch(() => {});

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

        /* Out of allowance is not a per-file problem: every remaining file
           would fail the same way, so the batch stops and says so once. */
        if (isQuotaError(message)) {
          stopped = queue.length - index - 1;
          for (const rest of queue.slice(index + 1)) patch(rest.id, { status: "queued", pct: 0 });
          break;
        }
      }
    }

    setBusy(false);
    void notify("end", failures);

    // The allowance moved, whether or not the files landed.
    await loadAccess().catch(() => {});

    if (stopped > 0) {
      setBlocked(
        `Your 1 TB storage allowance is full, so the upload stopped with ${stopped} file${
          stopped !== 1 ? "s" : ""
        } still queued. Ask your Velocity contact to free up room before trying again.`
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
