"use client";

import { useEffect, useMemo, useState } from "react";

type BdCall = {
  id: string;
  company: string;
  pocName: string;
  pocPhone: string;
  pocEmail: string | null;
  callDate: string;
  remarks: string | null;
  status: string;
  addedByUser: { id: string; name: string; designation: string };
};

const BD_STATUSES = ["FOLLOWUP", "LEAD", "DORMANT", "ACTIVE"] as const;
const statusLabel: Record<string, string> = { FOLLOWUP: "Follow Up", LEAD: "Lead", DORMANT: "Dormant", ACTIVE: "Active" };
const statusColor: Record<string, string> = { FOLLOWUP: "#e89b0c", LEAD: "#3b82f6", DORMANT: "#6b7280", ACTIVE: "#16b65f" };

const fmt = (iso: string) => {
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return iso; }
};

const getMonthLabel = () => {
  const d = new Date();
  return d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
};

export default function BusinessDevelopmentPage() {
  const [calls, setCalls] = useState<BdCall[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ company: "", pocName: "", pocPhone: "", pocEmail: "", callDate: "", remarks: "", status: "ACTIVE" });

  useEffect(() => {
    fetch("/api/bd-calls").then((r) => r.json()).then(setCalls).catch(() => {});
  }, []);

  const leaderboard = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = calls.filter((c) => new Date(c.callDate) >= monthStart);

    const counts: Record<string, { name: string; count: number }> = {};
    for (const c of thisMonth) {
      const uid = c.addedByUser.id;
      if (!counts[uid]) counts[uid] = { name: c.addedByUser.name, count: 0 };
      counts[uid].count++;
    }

    return Object.values(counts).sort((a, b) => b.count - a.count);
  }, [calls]);

  const handleAdd = async () => {
    const res = await fetch("/api/bd-calls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });
    if (res.ok) {
      const created = await res.json();
      setCalls((prev) => [created, ...prev]);
      setAddOpen(false);
      setForm({ company: "", pocName: "", pocPhone: "", pocEmail: "", callDate: "", remarks: "", status: "ACTIVE" });
    }
  };

  return (
    <>
      <section className="page-header">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1>Business Development</h1>
            <p>Track all BD calls and leads.</p>
          </div>
          <button className="btn-primary" type="button" onClick={() => setAddOpen(true)}>+ Add BD Call</button>
        </div>
      </section>

      {/* Monthly Leaderboard */}
      <section className="panel">
        <div className="panel-header claims-header">
          <h2>Leaderboard — {getMonthLabel()}</h2>
          <span className="muted">{leaderboard.reduce((s, l) => s + l.count, 0)} calls this month</span>
        </div>
        <div className="panel-body">
          {leaderboard.length === 0 ? (
            <div className="empty-state">No BD calls this month yet.</div>
          ) : (
            <div className="bd-leaderboard">
              {leaderboard.map((entry, i) => {
                const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "";
                return (
                  <div key={i} className="bd-leader-card">
                    <div className="bd-leader-rank">{medal || `#${i + 1}`}</div>
                    <div className="avatar" style={{ width: 36, height: 36, fontSize: 14 }}>{entry.name.charAt(0)}</div>
                    <div style={{ flex: 1 }}>
                      <strong>{entry.name}</strong>
                    </div>
                    <div className="bd-leader-count">{entry.count} call{entry.count !== 1 ? "s" : ""}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* BD Calls Table */}
      <section className="panel">
        <div className="panel-header"><h2>All BD Calls ({calls.length})</h2></div>
        <div className="panel-body">
          <div className="table-wrap">
            <table className="claims-table">
              <thead>
                <tr>
                  <th>S.No</th>
                  <th>Company</th>
                  <th>POC Name</th>
                  <th>POC Phone</th>
                  <th>POC Email</th>
                  <th>Date of Call</th>
                  <th>Relation To / Remarks</th>
                  <th>Status</th>
                  <th>Added By</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c, i) => {
                  const color = statusColor[c.status] ?? "#111";
                  return (
                    <tr key={c.id}>
                      <td>{i + 1}</td>
                      <td><strong>{c.company}</strong></td>
                      <td>{c.pocName}</td>
                      <td>{c.pocPhone}</td>
                      <td>{c.pocEmail || "—"}</td>
                      <td>{fmt(c.callDate)}</td>
                      <td>{c.remarks || "—"}</td>
                      <td>
                        <span className="phase-pill" style={{ background: `${color}18`, color }}>
                          {statusLabel[c.status] ?? c.status}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span className="avatar" style={{ width: 24, height: 24, fontSize: 10 }}>{c.addedByUser.name.charAt(0)}</span>
                          {c.addedByUser.name}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {calls.length === 0 && (
                  <tr><td colSpan={9} className="empty-state">No BD calls recorded yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Add BD Call Modal */}
      {addOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 480 }}>
            <h3>Add BD Call</h3>
            <label className="auth-label">Company</label>
            <input className="input" value={form.company} onChange={(e) => setForm((p) => ({ ...p, company: e.target.value }))} placeholder="Company name" />
            <label className="auth-label">POC Name</label>
            <input className="input" value={form.pocName} onChange={(e) => setForm((p) => ({ ...p, pocName: e.target.value }))} placeholder="Point of contact" />
            <label className="auth-label">POC Phone</label>
            <input className="input" value={form.pocPhone} onChange={(e) => setForm((p) => ({ ...p, pocPhone: e.target.value }))} placeholder="+91" />
            <label className="auth-label">POC Email</label>
            <input className="input" type="email" value={form.pocEmail} onChange={(e) => setForm((p) => ({ ...p, pocEmail: e.target.value }))} placeholder="email@example.com" />
            <label className="auth-label">Date of Call</label>
            <input className="input" type="date" value={form.callDate} onChange={(e) => setForm((p) => ({ ...p, callDate: e.target.value }))} />
            <label className="auth-label">Relation To / Remarks</label>
            <input className="input" value={form.remarks} onChange={(e) => setForm((p) => ({ ...p, remarks: e.target.value }))} placeholder="Reason for call, event reference, etc." />
            <label className="auth-label">Status</label>
            <select className="input select" value={form.status} onChange={(e) => setForm((p) => ({ ...p, status: e.target.value }))}>
              {BD_STATUSES.map((s) => <option key={s} value={s}>{statusLabel[s]}</option>)}
            </select>
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setAddOpen(false)}>Cancel</button>
              <button className="btn-primary" type="button" onClick={handleAdd} disabled={!form.company || !form.pocName || !form.callDate}>Save Call</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
