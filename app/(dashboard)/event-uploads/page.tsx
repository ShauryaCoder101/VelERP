"use client";

import { useEffect, useState } from "react";
import type { EventItem } from "../../../lib/events";

export default function EventUploadsPage() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  useEffect(() => {
    const loadEvents = async () => {
      const response = await fetch("/api/events");
      if (!response.ok) return;
      const data = await response.json();
      setEvents(
        data.map((eventItem: any) => ({
          id: eventItem.id,
          companyName: eventItem.companyName,
          eventName: eventItem.eventName,
          pocName: eventItem.pocName,
          pocPhone: eventItem.pocPhone,
          phase:
            eventItem.phase === "IDEATION"
              ? "Ideation"
              : eventItem.phase === "PITCHING"
                ? "Pitching"
                : eventItem.phase === "BIDDING"
                  ? "Bidding"
                  : eventItem.phase === "PREPARATION"
                    ? "Preparation"
                    : eventItem.phase === "ONGOING"
                      ? "Ongoing"
                      : "Finished",
          fromDate: eventItem.fromDate.slice(0, 10),
          toDate: eventItem.toDate.slice(0, 10),
          vendorIds: (eventItem.vendors ?? []).map((ev: any) => ev.vendorId),
          artistIds: (eventItem.artists ?? []).map((ea: any) => ea.artistId)
        }))
      );
    };
    loadEvents();
  }, []);

  const uploadFile = async (eventId: string, file: File) => {
    setUploadingId(eventId);
    try {
      const presignRes = await fetch("/api/uploads/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId,
          fileName: file.name,
          fileType: file.type
        })
      });
      if (!presignRes.ok) return;
      const { uploadUrl, fileUrl } = await presignRes.json();

      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file
      });
      if (!uploadRes.ok) return;

      await fetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId,
          fileUrl,
          fileType: file.type
        })
      });
    } finally {
      setUploadingId(null);
    }
  };

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Event Uploads</h1>
          <p>Upload event documents and assets.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header claims-header">
          <div>
            <h2>Event Uploads</h2>
            <p className="muted">Use the event list below to upload files.</p>
          </div>
        </div>
        <div className="panel-body">
          <div className="table-wrap">
            <table className="uploads-table">
              <thead>
                <tr>
                  <th>S.No</th>
                  <th>Event Name</th>
                  <th>Company Name</th>
                  <th>Phase</th>
                  <th>Upload</th>
                </tr>
              </thead>
              <tbody>
                {events.map((eventItem, index) => (
                  <tr key={eventItem.id}>
                    <td>{index + 1}</td>
                    <td>{eventItem.eventName}</td>
                    <td>{eventItem.companyName}</td>
                    <td>
                      <span className="phase-pill">{eventItem.phase}</span>
                    </td>
                    <td>
                      <input
                        className="input-file"
                        type="file"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (!file) return;
                          uploadFile(eventItem.id, file).catch(() => null);
                        }}
                      />
                      {uploadingId === eventItem.id ? <div className="muted">Uploading...</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
