"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

type UserRef = { id: string; name: string };
type Lead = {
  id: string; name: string; company: string; email: string | null; phone: string | null;
  address: string | null; source: string; status: string; notes: string | null;
  assignedTo: string | null; assignedToUser: UserRef | null; convertedDealId: string | null;
  createdAt: string; updatedAt: string;
};

const sourceLabel: Record<string, string> = { WEBSITE: "Website", REFERRAL: "Referral", SOCIAL_MEDIA: "Social Media", COLD_CALL: "Cold Call", EVENT: "Event", OTHER: "Other" };
const statusLabel: Record<string, string> = { NEW: "New", CONTACTED: "Contacted", QUALIFIED: "Qualified", UNQUALIFIED: "Unqualified" };
const statusColor: Record<string, string> = { NEW: "#3b82f6", CONTACTED: "#e89b0c", QUALIFIED: "#16b65f", UNQUALIFIED: "#6b7280" };

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [lead, setLead] = useState<Lead | null>(null);
  const [team, setTeam] = useState<UserRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignTo, setReassignTo] = useState("");
  const [addressEdit, setAddressEdit] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`/api/sales/leads/${id}`).then(r => r.ok ? r.json() : null),
      fetch("/api/team").then(r => r.json()).then((d: any[]) => d.map(u => ({ id: u.id, name: u.name })))
    ]).then(([l, t]) => {
      setLead(l);
      setTeam(t);
      if (l) setAddressEdit(l.address || "");
      setLoading(false);
    });
  }, [id]);

  const saveLead = async (data: Record<string, unknown>) => {
    setSaving(true);
    const res = await fetch(`/api/sales/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    if (res.ok) setLead(await res.json());
    setSaving(false);
  };

  const handleConvert = async () => {
    setSaving(true);
    const res = await fetch(`/api/sales/leads/${id}/convert`, { method: "POST" });
    if (res.ok) {
      const deal = await res.json();
      router.push(`/sales/deals/${deal.id}`);
    }
    setSaving(false);
  };

  const handleCloseLost = async () => {
    await saveLead({ status: "UNQUALIFIED" });
  };

  const handleReassign = async () => {
    await saveLead({ assignedTo: reassignTo || null });
    setReassignOpen(false);
  };

  const handleSaveAddress = async () => {
    await saveLead({ address: addressEdit });
    setEditOpen(false);
  };

  if (loading) return <div className="page-header"><h1>Loading...</h1></div>;
  if (!lead) return <div className="page-header"><h1>Lead not found</h1><Link href="/sales" className="btn-outline hover-text">← Back to Sales</Link></div>;

  const isConverted = !!lead.convertedDealId;
  const isLost = lead.status === "UNQUALIFIED";

  return (
    <>
      <section className="page-header">
        <Link href="/sales" className="hover-text" style={{ fontSize: 14, marginBottom: 8, display: "inline-block" }}>← Back to Sales</Link>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h1 style={{ margin: 0 }}>{lead.name}</h1>
            <span className="phase-pill" style={{ background: `${statusColor[lead.status]}18`, color: statusColor[lead.status] }}>
              {statusLabel[lead.status]}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!isConverted && !isLost && (
              <>
                <button className="btn-primary" type="button" onClick={handleConvert} disabled={saving}>
                  Push to Deal →
                </button>
                <button className="btn-outline hover-text" type="button" onClick={handleCloseLost} disabled={saving} style={{ borderColor: "#ef4444", color: "#ef4444" }}>
                  Close Lost
                </button>
              </>
            )}
            {isConverted && (
              <Link href={`/sales/deals/${lead.convertedDealId}`} className="btn-primary" style={{ textDecoration: "none" }}>
                View Deal →
              </Link>
            )}
            <button className="btn-outline hover-text" type="button" onClick={() => { setReassignTo(lead.assignedTo || ""); setReassignOpen(true); }}>
              Reassign
            </button>
          </div>
        </div>
      </section>

      <div className="sales-detail-grid">
        {/* Lead Information */}
        <section className="panel">
          <div className="panel-header"><h3>Lead Information</h3></div>
          <div className="panel-body">
            <div className="detail-grid">
              <div className="detail-item"><span className="detail-label">Name</span><span className="detail-value">{lead.name}</span></div>
              <div className="detail-item"><span className="detail-label">Company</span><span className="detail-value">{lead.company}</span></div>
              <div className="detail-item"><span className="detail-label">Email</span><span className="detail-value">{lead.email || "—"}</span></div>
              <div className="detail-item"><span className="detail-label">Phone</span><span className="detail-value">{lead.phone || "—"}</span></div>
              <div className="detail-item"><span className="detail-label">Source</span><span className="detail-value">{sourceLabel[lead.source]}</span></div>
              <div className="detail-item"><span className="detail-label">Status</span><span className="detail-value">{statusLabel[lead.status]}</span></div>
              <div className="detail-item"><span className="detail-label">Assigned To</span><span className="detail-value">{lead.assignedToUser?.name || "Unassigned"}</span></div>
              <div className="detail-item"><span className="detail-label">Created</span><span className="detail-value">{new Date(lead.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span></div>
            </div>
          </div>
        </section>

        {/* Address */}
        <section className="panel">
          <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3>Address Details</h3>
            {!editOpen && <button className="link-button hover-text" type="button" onClick={() => { setAddressEdit(lead.address || ""); setEditOpen(true); }}>Edit</button>}
          </div>
          <div className="panel-body">
            {editOpen ? (
              <div>
                <textarea className="input textarea" rows={3} value={addressEdit} onChange={e => setAddressEdit(e.target.value)} placeholder="Enter full address..." />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button className="btn-primary" type="button" onClick={handleSaveAddress} disabled={saving}>Save</button>
                  <button className="btn-outline hover-text" type="button" onClick={() => setEditOpen(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <p style={{ color: lead.address ? "inherit" : "var(--gray-400)", margin: 0, whiteSpace: "pre-wrap" }}>
                {lead.address || "No address added yet."}
              </p>
            )}
          </div>
        </section>

        {/* Notes */}
        <section className="panel" style={{ gridColumn: "1 / -1" }}>
          <div className="panel-header"><h3>Notes</h3></div>
          <div className="panel-body">
            <p style={{ color: lead.notes ? "inherit" : "var(--gray-400)", margin: 0, whiteSpace: "pre-wrap" }}>
              {lead.notes || "No notes."}
            </p>
          </div>
        </section>
      </div>

      {/* Reassign Modal */}
      {reassignOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 400 }}>
            <h3>Reassign Lead</h3>
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
