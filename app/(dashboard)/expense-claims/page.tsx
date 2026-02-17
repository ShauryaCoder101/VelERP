"use client";

import { useState } from "react";
import { currentUser } from "../../../lib/auth";

type ClaimRow = {
  id: number;
  event: string;
  location: string;
  type: string;
  date: string;
  amount: string;
  attachment?: File | null;
};

const createRow = (id: number): ClaimRow => ({
  id,
  event: "",
  location: "",
  type: "",
  date: "",
  amount: "",
  attachment: null
});

export default function ExpenseClaimsPage() {
  const [rows, setRows] = useState<ClaimRow[]>([createRow(1)]);

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

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = {
      items: rows.map((row) => ({
        eventName: row.event,
        location: row.location,
        type: row.type,
        date: row.date,
        amount: Number(row.amount)
      })),
      attachments: rows
        .map((row) => row.attachment)
        .filter(Boolean)
        .map((file) => ({
          fileUrl: (file as File).name,
          fileType: (file as File).type
        }))
    };
    fetch("/api/expense-claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => null);
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
            <p className="muted">Submitted by UID: {currentUser.uid}</p>
          </div>
          <div className="claims-actions">
            <button className="btn-outline hover-text" type="button" onClick={handleAddRow}>
              Add a Row
            </button>
            <button className="btn-primary" type="submit" form="claims-form">
              Submit
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
                        <input
                          className="input"
                          value={row.event}
                          onChange={(event) => handleRowChange(row.id, "event", event.target.value)}
                          placeholder="Event name"
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          value={row.location}
                          onChange={(event) =>
                            handleRowChange(row.id, "location", event.target.value)
                          }
                          placeholder="City / Venue"
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          value={row.type}
                          onChange={(event) => handleRowChange(row.id, "type", event.target.value)}
                          placeholder="Travel, Food..."
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          type="date"
                          value={row.date}
                          onChange={(event) => handleRowChange(row.id, "date", event.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          type="number"
                          min="0"
                          value={row.amount}
                          onChange={(event) => handleRowChange(row.id, "amount", event.target.value)}
                          placeholder="0.00"
                        />
                      </td>
                      <td>
                        <input
                          className="input-file"
                          type="file"
                          accept=".pdf,.jpeg,.jpg"
                          onChange={(event) =>
                            handleRowChange(row.id, "attachment", event.target.files?.[0] ?? null)
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
