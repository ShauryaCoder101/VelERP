"use client";

import { useEffect, useState } from "react";

type EventOption = { id: string; eventName: string; companyName: string };

type ClaimRow = {
  id: number;
  eventId: string;
  location: string;
  type: string;
  date: string;
  amount: string;
  attachment?: File | null;
};

const createRow = (id: number): ClaimRow => ({
  id,
  eventId: "",
  location: "",
  type: "",
  date: "",
  amount: "",
  attachment: null
});

export default function ExpenseClaimsPage() {
  const [rows, setRows] = useState<ClaimRow[]>([createRow(1)]);
  const [events, setEvents] = useState<EventOption[]>([]);

  useEffect(() => {
    fetch("/api/events")
      .then((r) => r.json())
      .then((data: any[]) => {
        const active = data
          .filter((e) => e.phase !== "FINISHED")
          .map((e) => ({ id: e.id, eventName: e.eventName, companyName: e.companyName }));
        setEvents(active);
      })
      .catch(() => {});
  }, []);

  const handleRowChange = (id: number, field: keyof ClaimRow, value: string | File | null) => {
    setRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, [field]: value } : row))
    );
  };

  const handleAddRow = () => {
    setRows((prev) => [...prev, createRow(prev.length + 1)]);
  };

  const handleRemoveRow = (id: number) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
  };

  const [submitting, setSubmitting] = useState(false);

  const uploadFileToS3 = async (file: File, eventId: string): Promise<{ fileUrl: string; fileType: string } | null> => {
    try {
      // 1. Get presigned URL from server
      const presignRes = await fetch("/api/uploads/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, fileType: file.type, eventId })
      });
      if (!presignRes.ok) return null;
      const { uploadUrl, fileUrl } = await presignRes.json();

      // 2. PUT file directly to S3
      await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file
      });

      return { fileUrl, fileType: file.type };
    } catch {
      return null;
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    for (const row of rows) {
      if (!row.eventId || !row.date || !row.amount) continue;
      const selectedEvent = events.find((ev) => ev.id === row.eventId);

      // Upload attachment to S3 if present
      let attachments: { fileUrl: string; fileType: string }[] = [];
      if (row.attachment) {
        const uploaded = await uploadFileToS3(row.attachment, row.eventId);
        if (uploaded) attachments = [uploaded];
      }

      await fetch("/api/expense-claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: row.eventId,
          items: [{
            eventName: selectedEvent?.eventName ?? "",
            location: row.location,
            type: row.type,
            date: row.date,
            amount: Number(row.amount)
          }],
          attachments
        })
      }).catch(() => null);
    }
    setSubmitting(false);
    setRows([createRow(1)]);
  };

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Expense Claims</h1>
          <p>Submit and track expense claims.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header claims-header">
          <div>
            <h2>Expense Claim Form</h2>
            <p className="muted">Select an active event to file a claim against.</p>
          </div>
          <div className="claims-actions">
            <button className="btn-outline hover-text" type="button" onClick={handleAddRow}>
              Add a Row
            </button>
            <button className="btn-primary" type="submit" form="claims-form" disabled={submitting}>
              {submitting ? "Uploading…" : "Submit"}
            </button>
          </div>
        </div>
        <div className="panel-body">
          <form id="claims-form" className="claims-form" onSubmit={handleSubmit}>
            <div className="table-wrap">
              <table className="claims-table">
                <thead>
                  <tr>
                    <th>S.No</th>
                    <th>Event</th>
                    <th>Location</th>
                    <th>Type</th>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Attach a File</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={row.id}>
                      <td>{index + 1}</td>
                      <td>
                        <select
                          className="input select"
                          value={row.eventId}
                          onChange={(ev) => handleRowChange(row.id, "eventId", ev.target.value)}
                        >
                          <option value="">Select event</option>
                          {events.map((ev) => (
                            <option key={ev.id} value={ev.id}>
                              {ev.eventName} ({ev.companyName})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="input"
                          value={row.location}
                          onChange={(ev) => handleRowChange(row.id, "location", ev.target.value)}
                          placeholder="City / Venue"
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          value={row.type}
                          onChange={(ev) => handleRowChange(row.id, "type", ev.target.value)}
                          placeholder="Travel, Food..."
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          type="date"
                          value={row.date}
                          onChange={(ev) => handleRowChange(row.id, "date", ev.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          type="number"
                          min="0"
                          value={row.amount}
                          onChange={(ev) => handleRowChange(row.id, "amount", ev.target.value)}
                          placeholder="0.00"
                        />
                      </td>
                      <td>
                        <input
                          className="input-file"
                          type="file"
                          accept=".pdf,.jpeg,.jpg"
                          onChange={(ev) =>
                            handleRowChange(row.id, "attachment", ev.target.files?.[0] ?? null)
                          }
                        />
                      </td>
                      <td>
                        <button
                          className="row-remove"
                          type="button"
                          aria-label="Remove row"
                          onClick={() => handleRemoveRow(row.id)}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </form>
        </div>
      </section>
    </>
  );
}
