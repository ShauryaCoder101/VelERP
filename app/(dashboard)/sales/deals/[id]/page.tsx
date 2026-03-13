"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

type UserRef = { id: string; name: string };
type AccountRef = { id: string; companyName: string };
type Deal = {
  id: string; dealName: string; accountId: string | null; stage: string;
  amount: number; expectedCloseDate: string | null; notes: string | null;
  assignedTo: string | null; account: AccountRef | null; assignedToUser: UserRef | null;
  createdAt: string; updatedAt: string;
};

const STAGES = [
  "QUALIFICATION", "NEEDS_ANALYSIS", "VALUE_PROPOSITION",
  "IDENTIFY_DECISION_MAKERS", "PROPOSAL_PRICE_QUOTE", "NEGOTIATION_REVIEW",
  "CLOSED_WON", "CLOSED_LOST"
];
const stageLabel: Record<string, string> = {
  QUALIFICATION: "Qualification", NEEDS_ANALYSIS: "Needs Analysis",
  VALUE_PROPOSITION: "Value Proposition", IDENTIFY_DECISION_MAKERS: "Identify Decision Makers",
  PROPOSAL_PRICE_QUOTE: "Proposal / Price Quote", NEGOTIATION_REVIEW: "Negotiation / Review",
  CLOSED_WON: "Closed Won", CLOSED_LOST: "Closed Lost"
};
const stageColor: Record<string, string> = {
  QUALIFICATION: "#3b82f6", NEEDS_ANALYSIS: "#6366f1", VALUE_PROPOSITION: "#8b5cf6",
  IDENTIFY_DECISION_MAKERS: "#a855f7", PROPOSAL_PRICE_QUOTE: "#d946ef",
  NEGOTIATION_REVIEW: "#e89b0c", CLOSED_WON: "#16b65f", CLOSED_LOST: "#6b7280"
};

const fmt = (iso: string) => {
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return iso; }
};

export default function DealDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [deal, setDeal] = useState<Deal | null>(null);
  const [team, setTeam] = useState<UserRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignTo, setReassignTo] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`/api/sales/deals/${id}`).then(r => r.ok ? r.json() : null),
      fetch("/api/team").then(r => r.json()).then((d: any[]) => d.map(u => ({ id: u.id, name: u.name })))
    ]).then(([d, t]) => {
      setDeal(d);
      setTeam(t);
      setLoading(false);
    });
  }, [id]);

  const updateDeal = async (data: Record<string, unknown>) => {
    setSaving(true);
    const res = await fetch(`/api/sales/deals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    if (res.ok) setDeal(await res.json());
    setSaving(false);
  };

  const handlePushStage = async () => {
    if (!deal) return;
    const openStages = STAGES.filter(s => s !== "CLOSED_WON" && s !== "CLOSED_LOST");
    const idx = openStages.indexOf(deal.stage);
    if (idx < 0 || idx >= openStages.length - 1) return;
    await updateDeal({ stage: openStages[idx + 1] });
  };

  const handleCloseLost = async () => { await updateDeal({ stage: "CLOSED_LOST" }); };
  const handleCloseWon = async () => { await updateDeal({ stage: "CLOSED_WON" }); };

  const handleReassign = async () => {
    await updateDeal({ assignedTo: reassignTo || null });
    setReassignOpen(false);
  };

  const handleDelete = async () => {
    if (!confirm("Delete this deal permanently?")) return;
    await fetch(`/api/sales/deals/${id}`, { method: "DELETE" });
    router.push("/sales");
  };

  if (loading) return <div className="page-header"><h1>Loading...</h1></div>;
  if (!deal) return <div className="page-header"><h1>Deal not found</h1><Link href="/sales" className="btn-outline hover-text">← Back to Sales</Link></div>;

  const isClosed = deal.stage === "CLOSED_WON" || deal.stage === "CLOSED_LOST";
  const openStages = STAGES.filter(s => s !== "CLOSED_WON" && s !== "CLOSED_LOST");
  const currentIdx = openStages.indexOf(deal.stage);
  const canPush = !isClosed && currentIdx < openStages.length - 1;

  return (
    <>
      <section className="page-header">
        <Link href="/sales" className="hover-text" style={{ fontSize: 14, marginBottom: 8, display: "inline-block" }}>← Back to Sales</Link>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h1 style={{ margin: 0 }}>{deal.dealName}</h1>
            <span className="phase-pill" style={{ background: `${stageColor[deal.stage]}18`, color: stageColor[deal.stage], fontWeight: 600 }}>
              {stageLabel[deal.stage]}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {canPush && (
              <button className="btn-primary" type="button" onClick={handlePushStage} disabled={saving}>
                Push to {stageLabel[openStages[currentIdx + 1]]} →
              </button>
            )}
            {!isClosed && (
              <>
                <button className="btn-outline hover-text" type="button" onClick={handleCloseWon} disabled={saving} style={{ borderColor: "#16b65f", color: "#16b65f" }}>
                  Close Won
                </button>
                <button className="btn-outline hover-text" type="button" onClick={handleCloseLost} disabled={saving} style={{ borderColor: "#ef4444", color: "#ef4444" }}>
                  Close Lost
                </button>
              </>
            )}
            <button className="btn-outline hover-text" type="button" onClick={() => { setReassignTo(deal.assignedTo || ""); setReassignOpen(true); }}>
              Reassign
            </button>
            <button className="btn-outline hover-text" type="button" onClick={handleDelete} style={{ borderColor: "#ef4444", color: "#ef4444" }}>
              Delete
            </button>
          </div>
        </div>
      </section>

      {/* Stage Progress Bar */}
      <div className="stage-progress">
        <div className="stage-progress-bar">
          {openStages.map((s, i) => {
            const done = currentIdx >= 0 && i <= currentIdx;
            const active = deal.stage === s;
            return (
              <div key={s} className={`stage-step ${done ? "stage-step-done" : ""} ${active ? "stage-step-active" : ""}`}>
                <div className="stage-dot" />
                <span className="stage-label">{stageLabel[s]}</span>
              </div>
            );
          })}
          {isClosed && (
            <div className={`stage-step stage-step-active ${deal.stage === "CLOSED_WON" ? "stage-step-won" : "stage-step-lost"}`}>
              <div className="stage-dot" />
              <span className="stage-label">{stageLabel[deal.stage]}</span>
            </div>
          )}
        </div>
      </div>

      <div className="sales-detail-grid">
        <section className="panel">
          <div className="panel-header"><h3>Deal Information</h3></div>
          <div className="panel-body">
            <div className="detail-grid">
              <div className="detail-item"><span className="detail-label">Deal Name</span><span className="detail-value">{deal.dealName}</span></div>
              <div className="detail-item"><span className="detail-label">Account</span><span className="detail-value">{deal.account?.companyName || "—"}</span></div>
              <div className="detail-item"><span className="detail-label">Amount</span><span className="detail-value" style={{ fontWeight: 700, fontSize: 18 }}>₹{deal.amount.toLocaleString("en-IN")}</span></div>
              <div className="detail-item"><span className="detail-label">Expected Close</span><span className="detail-value">{deal.expectedCloseDate ? fmt(deal.expectedCloseDate) : "—"}</span></div>
              <div className="detail-item"><span className="detail-label">Assigned To</span><span className="detail-value">{deal.assignedToUser?.name || "Unassigned"}</span></div>
              <div className="detail-item"><span className="detail-label">Stage</span><span className="detail-value">{stageLabel[deal.stage]}</span></div>
              <div className="detail-item"><span className="detail-label">Created</span><span className="detail-value">{fmt(deal.createdAt)}</span></div>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header"><h3>Notes</h3></div>
          <div className="panel-body">
            <p style={{ color: deal.notes ? "inherit" : "var(--gray-400)", margin: 0, whiteSpace: "pre-wrap" }}>
              {deal.notes || "No notes."}
            </p>
          </div>
        </section>
      </div>

      {/* Reassign Modal */}
      {reassignOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 400 }}>
            <h3>Reassign Deal</h3>
            <label className="auth-label">Assign To</label>
            <select className="input select" value={reassignTo} onChange={e => setReassignTo(e.target.value)}>
              <option value="">Unassigned</option>
              {team.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setReassignOpen(false)}>Cancel</button>
              <button className="btn-primary" type="button" onClick={handleReassign} disabled={saving}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
