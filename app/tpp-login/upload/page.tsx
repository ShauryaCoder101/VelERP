"use client";

import { useEffect, useState } from "react";

type EventOption = {
  id: string;
  eventName: string;
  companyName: string;
  phase: string;
};

export default function PhotographerUploadPage() {
  const [events, setEvents] = useState<EventOption[]>([]);
  const [eventId, setEventId] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const loadEvents = async () => {
      const response = await fetch("/api/events");
      if (!response.ok) return;
      const data = await response.json();
      setEvents(
        data.map((eventItem: any) => ({
          id: eventItem.id,
          eventName: eventItem.eventName,
          companyName: eventItem.companyName,
          phase: eventItem.phase
        }))
      );
    };
    loadEvents();
  }, []);

  const handleUpload = async () => {
    if (!eventId || selectedFiles.length === 0) {
      setStatus("Select an event and files to upload.");
      return;
    }
    setStatus("Uploading...");
    for (const file of selectedFiles) {
      const presignRes = await fetch("/api/uploads/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId,
          fileName: file.name,
          fileType: file.type
        })
      });
      if (!presignRes.ok) {
        setStatus("Upload failed. Please try again.");
        return;
      }
      const { uploadUrl, fileUrl } = await presignRes.json();

      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file
      });
      if (!uploadRes.ok) {
        setStatus("Upload failed. Please try again.");
        return;
      }

      const recordRes = await fetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId,
          fileUrl,
          fileType: file.type
        })
      });
      if (!recordRes.ok) {
        setStatus("Upload failed. Please try again.");
        return;
      }
    }
    setStatus("Upload recorded.");
    setSelectedFiles([]);
  };

  return (
    <div className="upload-form">
      <h1>Upload Event Photos</h1>
      <p className="muted">Select an event and upload photo files.</p>

      <label className="auth-label" htmlFor="photo-event">
        Event
      </label>
      <select
        id="photo-event"
        className="input select"
        value={eventId}
        onChange={(event) => setEventId(event.target.value)}
      >
        <option value="">Select event</option>
        {events.map((eventItem) => (
          <option key={eventItem.id} value={eventItem.id}>
            {eventItem.eventName} ({eventItem.companyName})
          </option>
        ))}
      </select>

      <label className="auth-label" htmlFor="photo-file">
        Photos
      </label>
      <input
        id="photo-file"
        className="input-file"
        type="file"
        multiple
        onChange={(event) => setSelectedFiles(Array.from(event.target.files ?? []))}
      />

      {status ? <div className="muted">{status}</div> : null}

      <button className="btn-primary" type="button" onClick={handleUpload}>
        Upload
      </button>
    </div>
  );
}
