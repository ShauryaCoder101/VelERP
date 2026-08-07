"use client";

import { useEffect, useMemo, useState } from "react";
import { uploadFile, MULTIPART_THRESHOLD } from "../../../lib/upload-client";

type EventOption = {
  id: string;
  eventName: string;
  companyName: string;
  phase: string;
};

type ItemStatus = "queued" | "uploading" | "done" | "error";

type Item = {
  id: string;
  file: File;
  status: ItemStatus;
  pct: number;
  error?: string;
};

const formatBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

/* The browser must send exactly the Content-Type the URL was signed for,
   or S3 rejects the PUT. Some cameras hand us files with an empty type,
   so both sides agree on this fallback. */
const contentTypeOf = (file: File) => file.type || "application/octet-stream";

export default function PhotographerUploadPage() {
  const [events, setEvents] = useState<EventOption[]>([]);
  const [eventId, setEventId] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/events")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) =>
        setEvents(
          (Array.isArray(data) ? data : []).map((e: any) => ({
            id: e.id,
            eventName: e.eventName,
            companyName: e.companyName,
            phase: e.phase
          }))
        )
      )
      .catch(() => setNotice("Could not load the event list. Reload the page to try again."));
  }, []);

  const totalBytes = useMemo(() => items.reduce((s, i) => s + i.file.size, 0), [items]);
  const pending = items.filter((i) => i.status === "queued" || i.status === "error");
  const doneCount = items.filter((i) => i.status === "done").length;

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    setNotice("");
    setItems((prev) => [
      ...prev,
      ...Array.from(files).map((file, i) => ({
        id: `${Date.now()}-${i}-${file.name}`,
        file,
        status: "queued" as ItemStatus,
        pct: 0
      }))
    ]);
  };

  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id));

  const patch = (id: string, next: Partial<Item>) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...next } : i)));

  const handleUpload = async () => {
    if (!eventId) {
      setNotice("Choose the event these files belong to.");
      return;
    }
    if (pending.length === 0) {
      setNotice("Add some photos or video first.");
      return;
    }

    setBusy(true);
    setNotice("");
    let failures = 0;

    const batchBytes = pending.reduce((sum, i) => sum + i.file.size, 0);
    const notify = (phase: "start" | "end", failed = 0) =>
      fetch("/api/uploads/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, phase, fileCount: pending.length, totalBytes: batchBytes, failed })
      }).catch(() => {});

    void notify("start");

    // One bad file must not strand the rest of the shoot.
    for (const item of pending) {
      patch(item.id, { status: "uploading", pct: 0, error: undefined });
      try {
        const presignRes = await fetch("/api/uploads/presign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventId,
            fileName: item.file.name,
            fileType: contentTypeOf(item.file),
            purpose: "media"
          })
        });
        if (!presignRes.ok) throw new Error("Could not get an upload link");

        const { uploadUrl, fileUrl: simpleUrl } = await presignRes.json();

        /* Multi-gigabyte video is the norm here, so anything large is split
           into parts — a dropped connection retries one chunk, not the file. */
        const fileUrl = await uploadFile(
          item.file,
          { eventId, relativePath: "", purpose: "media", presignedUrl: uploadUrl, fileUrl: simpleUrl },
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

    setBusy(false);
    void notify("end", failures);
    setNotice(
      failures === 0
        ? `${pending.length} file${pending.length !== 1 ? "s" : ""} uploaded.`
        : `${pending.length - failures} uploaded, ${failures} failed. Press Upload again to retry the failures.`
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
        <label className="auth-label" htmlFor="photo-event">Event</label>
        <select
          id="photo-event"
          className="input select"
          value={eventId}
          disabled={busy}
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

        <label className="auth-label" htmlFor="photo-file">Photos &amp; video</label>
        <input
          id="photo-file"
          className="input-file"
          type="file"
          multiple
          accept="image/*,video/*,.zip,.rar,.7z"
          disabled={busy}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {items.length > 0 && (
          <div className="uploader-list">
            <div className="uploader-list-head">
              <span>{items.length} file{items.length !== 1 ? "s" : ""} · {formatBytes(totalBytes)}</span>
              {doneCount > 0 && <span>{doneCount} uploaded</span>}
            </div>
            {items.map((item) => (
              <div key={item.id} className={`uploader-row uploader-${item.status}`}>
                <span className="uploader-name" title={item.file.name}>{item.file.name}</span>
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

        <button className="btn-primary auth-submit" type="button" onClick={handleUpload} disabled={busy}>
          {busy
            ? "Uploading…"
            : pending.length > 0
              ? `Upload ${pending.length} file${pending.length !== 1 ? "s" : ""}`
              : "Upload"}
        </button>
      </div>
    </>
  );
}
