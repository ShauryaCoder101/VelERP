"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

type FinanceRow = {
  id: string;
  vendorId: string;
  vendorName: string;
  vendorWork: string;
  quotedAmount: number;
  advancePaid: number;
  totalPaid: number;
  closed: boolean;
  notes: string;
};

type EventDetail = {
  id: string;
  companyName: string;
  eventName: string;
  pocName: string;
  pocPhone: string;
  phase: string;
  fromDate: string;
  toDate: string;
  vendors: { vendor: { id: string; companyName: string; phone: string; work: string; location?: string; gstin?: string; panCard?: string; pocName?: string } }[];
  teamMembers: { user: { id: string; name: string; designation: string } }[];
  finances: any[];
  claims: any[];
};

const phaseLabel = (p: string) => {
  const map: Record<string, string> = {
    IDEATION: "Ideation", PITCHING: "Pitching", BIDDING: "Bidding",
    PREPARATION: "Preparation", ONGOING: "Ongoing", FINISHED: "Finished"
  };
  return map[p] ?? p;
};

const phaseColor = (p: string): string => {
  const upper = (typeof p === "string" ? p : "").toUpperCase();
  switch (upper) {
    case "ONGOING": return "#16b65f";
    case "PREPARATION": return "#e89b0c";
    case "BIDDING": return "#3b82f6";
    case "PITCHING": return "#8b5cf6";
    case "FINISHED": return "#6b7280";
    default: return "#e1162a";
  }
};

const fmt = (iso: string) => {
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return iso; }
};

const cur = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/* Skeleton */
const SkeletonPanel = ({ rows = 4 }: { rows?: number }) => (
  <section className="skeleton-panel">
    <div className="skeleton skeleton-panel-header" />
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="skeleton-dl-row">
        <div className="skeleton skeleton-dl-label" />
        <div className="skeleton skeleton-dl-value" />
      </div>
    ))}
  </section>
);

export default function AccountantEventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [ev, setEv] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [finances, setFinances] = useState<FinanceRow[]>([]);

  // Finance edit state
  const [financeEditId, setFinanceEditId] = useState<string | null>(null);
  const [financeForm, setFinanceForm] = useState({ quotedAmount: 0, advancePaid: 0, totalPaid: 0, notes: "" });
  const [financeSaving, setFinanceSaving] = useState(false);

  const loadEvent = () => {
    fetch(`/api/events/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setEv(d);
        if (d?.finances) {
          setFinances(d.finances.map((f: any) => ({
            id: f.id,
            vendorId: f.vendorId,
            vendorName: f.vendor?.companyName ?? "",
            vendorWork: f.vendor?.work ?? "",
            quotedAmount: f.quotedAmount,
            advancePaid: f.advancePaid,
            totalPaid: f.totalPaid,
            closed: f.closed,
            notes: f.notes ?? ""
          })));
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => { loadEvent(); }, [id]);

  const openFinanceEdit = (vendorId: string) => {
    const existing = finances.find((f) => f.vendorId === vendorId);
    setFinanceEditId(vendorId);
    setFinanceForm({
      quotedAmount: existing?.quotedAmount ?? 0,
      advancePaid: existing?.advancePaid ?? 0,
      totalPaid: existing?.totalPaid ?? 0,
      notes: existing?.notes ?? ""
    });
  };

  const saveFinance = async () => {
    if (!ev || !financeEditId) return;
    setFinanceSaving(true);
    const res = await fetch(`/api/events/${ev.id}/finance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vendorId: financeEditId,
        quotedAmount: financeForm.quotedAmount,
        advancePaid: financeForm.advancePaid,
        totalPaid: financeForm.totalPaid,
        notes: financeForm.notes
      })
    });
    setFinanceSaving(false);
    if (!res.ok) return;
    const saved = await res.json();
    setFinances((prev) => {
      const idx = prev.findIndex((f) => f.vendorId === financeEditId);
      const row: FinanceRow = {
        id: saved.id,
        vendorId: saved.vendorId,
        vendorName: saved.vendor?.companyName ?? prev[idx]?.vendorName ?? "",
        vendorWork: saved.vendor?.work ?? prev[idx]?.vendorWork ?? "",
        quotedAmount: saved.quotedAmount,
        advancePaid: saved.advancePaid,
        totalPaid: saved.totalPaid,
        closed: saved.closed,
        notes: saved.notes ?? ""
      };
      if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
      return [...prev, row];
    });
    setFinanceEditId(null);
  };

  const closeVendorPayment = async (vendorId: string) => {
    if (!ev) return;
    await fetch(`/api/events/${ev.id}/finance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendorId, closed: true })
    });
    setFinances((prev) => prev.map((f) => f.vendorId === vendorId ? { ...f, closed: true } : f));
  };

  const reopenVendorPayment = async (vendorId: string) => {
    if (!ev) return;
    await fetch(`/api/events/${ev.id}/finance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendorId, closed: false })
    });
    setFinances((prev) => prev.map((f) => f.vendorId === vendorId ? { ...f, closed: false } : f));
  };

  if (loading) {
    return (
      <>
        <section className="page-header">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="skeleton" style={{ width: 70, height: 32, borderRadius: 999 }} />
            <div style={{ flex: 1 }}>
              <div className="skeleton skeleton-heading" />
              <div className="skeleton skeleton-subtext" />
            </div>
          </div>
        </section>
        <div className="event-detail-grid">
          <SkeletonPanel rows={7} />
          <SkeletonPanel rows={3} />
        </div>
      </>
    );
  }

  if (!ev) return <p style={{ padding: 32 }}>Event not found.</p>;

  const phase = phaseLabel(ev.phase);
  const color = phaseColor(ev.phase);

  const financeMap = new Map(finances.map((f) => [f.vendorId, f]));
  const allEventVendors = ev.vendors.map((v) => {
    const f = financeMap.get(v.vendor.id);
    return {
      vendorId: v.vendor.id, vendorName: v.vendor.companyName, vendorWork: v.vendor.work,
      quotedAmount: f?.quotedAmount ?? 0, advancePaid: f?.advancePaid ?? 0,
      totalPaid: f?.totalPaid ?? 0, closed: f?.closed ?? false, notes: f?.notes ?? ""
    };
  });

  const totalQuoted = allEventVendors.reduce((s, v) => s + v.quotedAmount, 0);
  const totalAdvance = allEventVendors.reduce((s, v) => s + v.advancePaid, 0);
  const totalPaidAll = allEventVendors.reduce((s, v) => s + v.totalPaid, 0);
  const totalBalance = totalQuoted - totalPaidAll;
  const totalClaims = (ev.claims ?? []).reduce((sum: number, c: any) => sum + (c.items ?? []).reduce((s: number, i: any) => s + i.amount, 0), 0);

  return (
    <>
      <section className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button className="btn-outline hover-text" type="button" onClick={() => router.push("/accountant/events")} style={{ padding: "6px 14px" }}>
            ← Back
          </button>
          <div style={{ flex: 1, minWidth: 180 }}>
            <h1>{ev.eventName}</h1>
            <p>{ev.companyName}</p>
          </div>
          <span className="phase-pill" style={{ background: `${color}18`, color }}>{phase}</span>
        </div>
      </section>

      <div className="event-detail-grid">
        {/* Event Info */}
        <section className="panel">
          <div className="panel-header"><h2>Event Info</h2></div>
          <div className="panel-body">
            <dl className="detail-dl">
              <div><dt>Company</dt><dd>{ev.companyName}</dd></div>
              <div><dt>Event Name</dt><dd>{ev.eventName}</dd></div>
              <div><dt>POC Name</dt><dd>{ev.pocName}</dd></div>
              <div><dt>POC Phone</dt><dd>{ev.pocPhone}</dd></div>
              <div><dt>Start Date</dt><dd>{fmt(ev.fromDate)}</dd></div>
              <div><dt>End Date</dt><dd>{fmt(ev.toDate)}</dd></div>
              <div><dt>Phase</dt><dd><span className="phase-pill" style={{ background: `${color}18`, color }}>{phase}</span></dd></div>
            </dl>
          </div>
        </section>

        {/* Vendors */}
        <section className="panel">
          <div className="panel-header"><h2>Vendors Involved</h2></div>
          <div className="panel-body">
            {ev.vendors.length === 0 ? (
              <p className="muted">No vendors linked.</p>
            ) : (
              <div className="detail-people-list">
                {ev.vendors.map((v) => (
                  <div key={v.vendor.id} className="detail-person-card">
                    <div className="avatar" style={{ width: 36, height: 36, fontSize: 14, background: "#3b82f6" }}>{v.vendor.companyName.charAt(0)}</div>
                    <div>
                      <strong>{v.vendor.companyName}</strong>
                      <span className="muted">{v.vendor.work}{v.vendor.location ? ` · ${v.vendor.location}` : ""}</span>
                      {v.vendor.phone && <span className="muted">{v.vendor.phone}</span>}
                      {v.vendor.gstin && <span className="muted">GSTIN: {v.vendor.gstin}</span>}
                      {v.vendor.panCard && <span className="muted">PAN: {v.vendor.panCard}</span>}
                      {v.vendor.pocName && <span className="muted">POC: {v.vendor.pocName}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ── Vendor Finance Section ── */}
      {ev.vendors.length > 0 && (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="panel-header claims-header">
            <div>
              <h2>Vendor Finance</h2>
              <p className="muted">Track negotiated amounts, advance payments, and balances.</p>
            </div>
            {totalQuoted > 0 && (
              <div style={{ display: "flex", gap: 20, fontSize: 13 }}>
                <span>Negotiated: <strong>{cur(totalQuoted)}</strong></span>
                <span>Paid: <strong>{cur(totalPaidAll)}</strong></span>
                <span style={{ color: totalBalance > 0 ? "var(--red)" : "#16b65f" }}>
                  Balance: <strong>{cur(totalBalance)}</strong>
                </span>
              </div>
            )}
          </div>
          <div className="panel-body">
            <div className="table-wrap">
              <table className="finance-table">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>Work</th>
                    <th>Negotiated</th>
                    <th>Advance Paid</th>
                    <th>Total Paid</th>
                    <th>To Be Done</th>
                    <th>Status</th>
                    <th>Notes</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {allEventVendors.map((v) => {
                    const balance = v.quotedAmount - v.totalPaid;
                    return (
                      <tr key={v.vendorId} style={v.closed ? { opacity: 0.6 } : {}}>
                        <td><strong>{v.vendorName}</strong></td>
                        <td className="muted">{v.vendorWork}</td>
                        <td className="amount-cell">{v.quotedAmount > 0 ? cur(v.quotedAmount) : "—"}</td>
                        <td className="amount-cell">{v.advancePaid > 0 ? cur(v.advancePaid) : "—"}</td>
                        <td className="amount-cell">{v.totalPaid > 0 ? cur(v.totalPaid) : "—"}</td>
                        <td className={`balance-cell ${balance <= 0 ? "settled" : ""}`}>
                          {v.quotedAmount > 0 ? cur(Math.max(0, balance)) : "—"}
                        </td>
                        <td>
                          <span className={`closed-pill ${v.closed ? "done" : "open"}`}>
                            {v.closed ? "✓ Closed" : "Open"}
                          </span>
                        </td>
                        <td className="muted" style={{ maxWidth: 160, fontSize: 12 }}>{v.notes || "—"}</td>
                        <td>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button className="finance-edit-btn" type="button" onClick={() => openFinanceEdit(v.vendorId)}>
                              Edit
                            </button>
                            {!v.closed ? (
                              <button className="finance-close-btn" type="button" onClick={() => closeVendorPayment(v.vendorId)}>
                                Close
                              </button>
                            ) : (
                              <button className="finance-edit-btn" type="button" onClick={() => reopenVendorPayment(v.vendorId)}>
                                Reopen
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {allEventVendors.length > 1 && (
                    <tr className="finance-summary-row">
                      <td colSpan={2}><strong>Totals</strong></td>
                      <td className="amount-cell">{cur(totalQuoted)}</td>
                      <td className="amount-cell">{cur(totalAdvance)}</td>
                      <td className="amount-cell">{cur(totalPaidAll)}</td>
                      <td className={`balance-cell ${totalBalance <= 0 ? "settled" : ""}`}>{cur(Math.max(0, totalBalance))}</td>
                      <td />
                      <td />
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Expense Claims summary */}
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-header claims-header">
          <h2>Expense Claims</h2>
          <span className="muted">{(ev.claims ?? []).length} claim{(ev.claims ?? []).length !== 1 ? "s" : ""} · {cur(totalClaims)}</span>
        </div>
        <div className="panel-body">
          {(ev.claims ?? []).length === 0 ? (
            <div className="empty-state">No expense claims filed for this event.</div>
          ) : (
            <div className="table-wrap">
              <table className="claims-table">
                <thead>
                  <tr><th>Filed By</th><th>Status</th><th>Items</th><th>Total Amount</th><th>Date</th></tr>
                </thead>
                <tbody>
                  {(ev.claims ?? []).map((claim: any) => {
                    const total = (claim.items ?? []).reduce((s: number, i: any) => s + i.amount, 0);
                    const statusLabel = claim.status === "ACTIVE" ? "Approved" : claim.status === "INACTIVE" ? "Pending" : claim.status;
                    const statusClass = claim.status === "ACTIVE" ? "active" : "inactive";
                    return (
                      <tr key={claim.id}>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{claim.user.name.charAt(0)}</span>
                            <div>
                              <strong>{claim.user.name}</strong>
                              <div className="muted">{claim.user.designation}</div>
                            </div>
                          </div>
                        </td>
                        <td><span className={`status-pill ${statusClass}`}>{statusLabel}</span></td>
                        <td>{(claim.items ?? []).length} item{(claim.items ?? []).length !== 1 ? "s" : ""}</td>
                        <td style={{ fontWeight: 600 }}>{cur(total)}</td>
                        <td className="muted">{fmt(claim.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Finance Edit Modal */}
      {financeEditId && ev && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 440 }}>
            <h3>Update Vendor Finance</h3>
            <p className="muted">{ev.vendors.find((v) => v.vendor.id === financeEditId)?.vendor.companyName ?? "Vendor"}</p>

            <label className="auth-label" htmlFor="fin-quoted">Total Negotiated (₹)</label>
            <input id="fin-quoted" className="input" type="number" min="0" step="1"
              value={financeForm.quotedAmount}
              onChange={(e) => setFinanceForm((p) => ({ ...p, quotedAmount: parseFloat(e.target.value) || 0 }))} />

            <label className="auth-label" htmlFor="fin-advance">Advance Paid (₹)</label>
            <input id="fin-advance" className="input" type="number" min="0" step="1"
              value={financeForm.advancePaid}
              onChange={(e) => setFinanceForm((p) => ({ ...p, advancePaid: parseFloat(e.target.value) || 0 }))} />

            <label className="auth-label" htmlFor="fin-paid">Total Paid (₹)</label>
            <input id="fin-paid" className="input" type="number" min="0" step="1"
              value={financeForm.totalPaid}
              onChange={(e) => setFinanceForm((p) => ({ ...p, totalPaid: parseFloat(e.target.value) || 0 }))} />

            <div style={{ background: "var(--gray-100)", padding: "10px 14px", borderRadius: 10, marginTop: 4 }}>
              <span className="muted">To Be Done: </span>
              <strong style={{ color: (financeForm.quotedAmount - financeForm.totalPaid) > 0 ? "var(--red)" : "#16b65f" }}>
                {cur(Math.max(0, financeForm.quotedAmount - financeForm.totalPaid))}
              </strong>
            </div>

            <label className="auth-label" htmlFor="fin-notes">Notes</label>
            <textarea id="fin-notes" className="input textarea" rows={2}
              value={financeForm.notes}
              onChange={(e) => setFinanceForm((p) => ({ ...p, notes: e.target.value }))}
              placeholder="Optional notes" />

            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setFinanceEditId(null)}>Cancel</button>
              <button className="btn-primary" type="button" onClick={saveFinance} disabled={financeSaving}>
                {financeSaving ? "Saving…" : "Save Finance"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
