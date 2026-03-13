"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/* ── Types ── */
type UserRef = { id: string; name: string };
type AccountRef = { id: string; companyName: string };

type Lead = {
  id: string; name: string; company: string; email: string | null; phone: string | null;
  address: string | null; source: string; status: string; notes: string | null;
  assignedTo: string | null; assignedToUser: UserRef | null; convertedDealId: string | null;
  createdAt: string;
};

type Contact = {
  id: string; name: string; email: string | null; phone: string | null;
  company: string | null; designation: string | null; accountId: string | null;
  account: AccountRef | null; notes: string | null; createdAt: string;
};

type Account = {
  id: string; companyName: string; industry: string | null; phone: string | null;
  email: string | null; website: string | null; address: string | null;
  notes: string | null; _count: { contacts: number; deals: number }; createdAt: string;
};

type Deal = {
  id: string; dealName: string; accountId: string | null; stage: string;
  amount: number; expectedCloseDate: string | null; notes: string | null;
  assignedTo: string | null; account: AccountRef | null; assignedToUser: UserRef | null;
  createdAt: string;
};

/* ── Constants ── */
type Tab = "pipeline" | "contacts" | "accounts";
const TABS: { key: Tab; label: string }[] = [
  { key: "pipeline", label: "Pipeline" },
  { key: "contacts", label: "Contacts" },
  { key: "accounts", label: "Accounts" }
];

const PIPELINE_STAGES = [
  "COLD_LEAD", "QUALIFICATION", "NEEDS_ANALYSIS", "VALUE_PROPOSITION",
  "IDENTIFY_DECISION_MAKERS", "PROPOSAL_PRICE_QUOTE", "NEGOTIATION_REVIEW",
  "CLOSED_WON", "CLOSED_LOST"
];

const LEAD_SOURCES = ["WEBSITE", "REFERRAL", "SOCIAL_MEDIA", "COLD_CALL", "EVENT", "OTHER"];

const stageLabel: Record<string, string> = {
  COLD_LEAD: "Cold Lead", QUALIFICATION: "Qualification", NEEDS_ANALYSIS: "Needs Analysis",
  VALUE_PROPOSITION: "Value Proposition", IDENTIFY_DECISION_MAKERS: "Identify Decision Makers",
  PROPOSAL_PRICE_QUOTE: "Proposal / Price Quote", NEGOTIATION_REVIEW: "Negotiation / Review",
  CLOSED_WON: "Closed Won", CLOSED_LOST: "Closed Lost"
};
const stageColor: Record<string, string> = {
  COLD_LEAD: "#64748b", QUALIFICATION: "#3b82f6", NEEDS_ANALYSIS: "#6366f1",
  VALUE_PROPOSITION: "#8b5cf6", IDENTIFY_DECISION_MAKERS: "#a855f7",
  PROPOSAL_PRICE_QUOTE: "#d946ef", NEGOTIATION_REVIEW: "#e89b0c",
  CLOSED_WON: "#16b65f", CLOSED_LOST: "#6b7280"
};
const sourceLabel: Record<string, string> = { WEBSITE: "Website", REFERRAL: "Referral", SOCIAL_MEDIA: "Social Media", COLD_CALL: "Cold Call", EVENT: "Event", OTHER: "Other" };

const fmt = (iso: string) => {
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return iso; }
};

export default function SalesPage() {
  const [tab, setTab] = useState<Tab>("pipeline");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [team, setTeam] = useState<UserRef[]>([]);
  const [pipelineStage, setPipelineStage] = useState("COLD_LEAD");

  const [addOpen, setAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [deleteItem, setDeleteItem] = useState<any>(null);

  /* ── Form states ── */
  const [leadForm, setLeadForm] = useState({ name: "", company: "", email: "", phone: "", source: "OTHER", notes: "", assignedTo: "" });
  const [contactForm, setContactForm] = useState({ name: "", email: "", phone: "", company: "", designation: "", accountId: "", notes: "" });
  const [accountForm, setAccountForm] = useState({ companyName: "", industry: "", phone: "", email: "", website: "", address: "", notes: "" });

  useEffect(() => {
    fetch("/api/sales/leads").then(r => r.json()).then(setLeads).catch(() => {});
    fetch("/api/sales/contacts").then(r => r.json()).then(setContacts).catch(() => {});
    fetch("/api/sales/accounts").then(r => r.json()).then(setAccounts).catch(() => {});
    fetch("/api/sales/deals").then(r => r.json()).then(setDeals).catch(() => {});
    fetch("/api/team").then(r => r.json()).then((d: any[]) => setTeam(d.map(u => ({ id: u.id, name: u.name })))).catch(() => {});
  }, []);

  const resetForms = () => {
    setLeadForm({ name: "", company: "", email: "", phone: "", source: "OTHER", notes: "", assignedTo: "" });
    setContactForm({ name: "", email: "", phone: "", company: "", designation: "", accountId: "", notes: "" });
    setAccountForm({ companyName: "", industry: "", phone: "", email: "", website: "", address: "", notes: "" });
  };

  const openAdd = () => { resetForms(); setEditItem(null); setAddOpen(true); };

  const openEdit = (item: any) => {
    setAddOpen(false);
    if (tab === "contacts") setContactForm({ name: item.name, email: item.email ?? "", phone: item.phone ?? "", company: item.company ?? "", designation: item.designation ?? "", accountId: item.accountId ?? "", notes: item.notes ?? "" });
    if (tab === "accounts") setAccountForm({ companyName: item.companyName, industry: item.industry ?? "", phone: item.phone ?? "", email: item.email ?? "", website: item.website ?? "", address: item.address ?? "", notes: item.notes ?? "" });
    setEditItem(item);
  };

  /* ── Pipeline item counts ── */
  const coldLeads = leads.filter(l => !l.convertedDealId && l.status !== "UNQUALIFIED");
  const stageCounts: Record<string, number> = { COLD_LEAD: coldLeads.length };
  PIPELINE_STAGES.filter(s => s !== "COLD_LEAD").forEach(s => {
    stageCounts[s] = deals.filter(d => d.stage === s).length;
  });

  const stageAmount: Record<string, number> = {};
  PIPELINE_STAGES.filter(s => s !== "COLD_LEAD").forEach(s => {
    stageAmount[s] = deals.filter(d => d.stage === s).reduce((sum, d) => sum + d.amount, 0);
  });

  const pipeline = deals.filter(d => !["CLOSED_WON", "CLOSED_LOST"].includes(d.stage)).reduce((s, d) => s + d.amount, 0);
  const wonTotal = deals.filter(d => d.stage === "CLOSED_WON").reduce((s, d) => s + d.amount, 0);

  /* ── CRUD ── */
  const handleSave = async () => {
    const isEdit = !!editItem;
    let url = "";
    let payload: unknown = {};

    if (tab === "pipeline" && pipelineStage === "COLD_LEAD") {
      url = "/api/sales/leads"; payload = { ...leadForm, status: "NEW" };
    }
    if (tab === "contacts") { url = "/api/sales/contacts"; payload = contactForm; }
    if (tab === "accounts") { url = "/api/sales/accounts"; payload = accountForm; }

    if (isEdit) url += `/${editItem.id}`;

    const res = await fetch(url, {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return;
    const saved = await res.json();

    if (tab === "pipeline") setLeads(prev => [saved, ...prev]);
    if (tab === "contacts") setContacts(prev => isEdit ? prev.map(x => x.id === saved.id ? saved : x) : [saved, ...prev]);
    if (tab === "accounts") setAccounts(prev => isEdit ? prev.map(x => x.id === saved.id ? saved : x) : [saved, ...prev]);

    setAddOpen(false);
    setEditItem(null);
    resetForms();
  };

  const handleDelete = async () => {
    if (!deleteItem) return;
    let url = "";
    if (tab === "contacts") url = `/api/sales/contacts/${deleteItem.id}`;
    if (tab === "accounts") url = `/api/sales/accounts/${deleteItem.id}`;

    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) return;

    if (tab === "contacts") setContacts(prev => prev.filter(x => x.id !== deleteItem.id));
    if (tab === "accounts") setAccounts(prev => prev.filter(x => x.id !== deleteItem.id));
    setDeleteItem(null);
  };

  const addLabel = tab === "pipeline" && pipelineStage === "COLD_LEAD" ? "Add Lead" : tab === "contacts" ? "Add Contact" : "Add Account";

  return (
    <>
      <section className="page-header">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1>Sales</h1>
            <p>Manage your sales pipeline, contacts, and accounts.</p>
          </div>
          {(tab !== "pipeline" || pipelineStage === "COLD_LEAD") && (
            <button className="btn-primary" type="button" onClick={openAdd}>+ {addLabel}</button>
          )}
        </div>
      </section>

      {/* Tabs */}
      <div className="sales-tabs">
        {TABS.map(t => (
          <button key={t.key} type="button" className={`sales-tab ${tab === t.key ? "sales-tab-active" : ""}`}
            onClick={() => { setTab(t.key); setAddOpen(false); setEditItem(null); }}>
            {t.label}
            <span className="sales-tab-count">
              {t.key === "pipeline" ? (coldLeads.length + deals.length) : t.key === "contacts" ? contacts.length : accounts.length}
            </span>
          </button>
        ))}
      </div>

      {/* Pipeline Tab */}
      {tab === "pipeline" && (
        <>
          {/* Pipeline summary */}
          <div className="sales-pipeline">
            <div className="sales-pipeline-item">
              <span className="muted">Open Pipeline</span>
              <strong>₹{pipeline.toLocaleString("en-IN")}</strong>
            </div>
            <div className="sales-pipeline-item">
              <span className="muted">Won</span>
              <strong style={{ color: "#16b65f" }}>₹{wonTotal.toLocaleString("en-IN")}</strong>
            </div>
            <div className="sales-pipeline-item">
              <span className="muted">Cold Leads</span>
              <strong>{coldLeads.length}</strong>
            </div>
            <div className="sales-pipeline-item">
              <span className="muted">Active Deals</span>
              <strong>{deals.filter(d => !["CLOSED_WON", "CLOSED_LOST"].includes(d.stage)).length}</strong>
            </div>
          </div>

          {/* Stage pills row */}
          <div className="pipeline-stages">
            {PIPELINE_STAGES.map(s => (
              <button key={s} type="button"
                className={`pipeline-stage-pill ${pipelineStage === s ? "pipeline-stage-active" : ""}`}
                style={{ "--pill-color": stageColor[s] } as React.CSSProperties}
                onClick={() => setPipelineStage(s)}>
                {stageLabel[s]}
                <span className="pipeline-stage-count">{stageCounts[s] ?? 0}</span>
              </button>
            ))}
          </div>

          {/* Stage content */}
          <section className="panel">
            <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
                <span className="stage-dot-inline" style={{ background: stageColor[pipelineStage] }} />
                {stageLabel[pipelineStage]}
                {pipelineStage !== "COLD_LEAD" && stageAmount[pipelineStage] > 0 && (
                  <span style={{ fontWeight: 400, fontSize: 14, color: "var(--gray-500)" }}>
                    — ₹{stageAmount[pipelineStage].toLocaleString("en-IN")}
                  </span>
                )}
              </h3>
            </div>
            <div className="panel-body">
              <div className="table-wrap">
                {pipelineStage === "COLD_LEAD" ? (
                  <table className="claims-table">
                    <thead><tr><th>S.No</th><th>Name</th><th>Company</th><th>Email</th><th>Phone</th><th>Source</th><th>Assigned To</th><th>Created</th></tr></thead>
                    <tbody>
                      {coldLeads.length === 0 ? <tr><td colSpan={8} className="empty-state">No cold leads.</td></tr> :
                        coldLeads.map((l, i) => (
                          <tr key={l.id} className="clickable-row">
                            <td>{i + 1}</td>
                            <td><Link href={`/sales/leads/${l.id}`} className="hover-text"><strong>{l.name}</strong></Link></td>
                            <td>{l.company}</td>
                            <td>{l.email || "—"}</td>
                            <td>{l.phone || "—"}</td>
                            <td>{sourceLabel[l.source] ?? l.source}</td>
                            <td>{l.assignedToUser?.name || "—"}</td>
                            <td>{fmt(l.createdAt)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="claims-table">
                    <thead><tr><th>S.No</th><th>Deal Name</th><th>Account</th><th>Amount</th><th>Expected Close</th><th>Assigned To</th><th>Created</th></tr></thead>
                    <tbody>
                      {deals.filter(d => d.stage === pipelineStage).length === 0 ? <tr><td colSpan={7} className="empty-state">No deals in this stage.</td></tr> :
                        deals.filter(d => d.stage === pipelineStage).map((d, i) => (
                          <tr key={d.id} className="clickable-row">
                            <td>{i + 1}</td>
                            <td><Link href={`/sales/deals/${d.id}`} className="hover-text"><strong>{d.dealName}</strong></Link></td>
                            <td>{d.account?.companyName || "—"}</td>
                            <td style={{ fontWeight: 600 }}>₹{d.amount.toLocaleString("en-IN")}</td>
                            <td>{d.expectedCloseDate ? fmt(d.expectedCloseDate) : "—"}</td>
                            <td>{d.assignedToUser?.name || "—"}</td>
                            <td>{fmt(d.createdAt)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>
        </>
      )}

      {/* Contacts Tab */}
      {tab === "contacts" && (
        <section className="panel">
          <div className="panel-body">
            <div className="table-wrap">
              <table className="claims-table">
                <thead><tr><th>S.No</th><th>Name</th><th>Email</th><th>Phone</th><th>Company</th><th>Designation</th><th>Account</th><th /><th /></tr></thead>
                <tbody>
                  {contacts.length === 0 ? <tr><td colSpan={9} className="empty-state">No contacts yet.</td></tr> : contacts.map((c, i) => (
                    <tr key={c.id}>
                      <td>{i + 1}</td>
                      <td><strong>{c.name}</strong></td>
                      <td>{c.email || "—"}</td>
                      <td>{c.phone || "—"}</td>
                      <td>{c.company || "—"}</td>
                      <td>{c.designation || "—"}</td>
                      <td>{c.account?.companyName || "—"}</td>
                      <td><button className="link-button hover-text" type="button" onClick={() => openEdit(c)}>Edit</button></td>
                      <td><button className="row-remove" type="button" onClick={() => setDeleteItem(c)}>×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Accounts Tab */}
      {tab === "accounts" && (
        <section className="panel">
          <div className="panel-body">
            <div className="table-wrap">
              <table className="claims-table">
                <thead><tr><th>S.No</th><th>Company</th><th>Industry</th><th>Phone</th><th>Email</th><th>Website</th><th>Contacts</th><th>Deals</th><th /><th /></tr></thead>
                <tbody>
                  {accounts.length === 0 ? <tr><td colSpan={10} className="empty-state">No accounts yet.</td></tr> : accounts.map((a, i) => (
                    <tr key={a.id}>
                      <td>{i + 1}</td>
                      <td><strong>{a.companyName}</strong></td>
                      <td>{a.industry || "—"}</td>
                      <td>{a.phone || "—"}</td>
                      <td>{a.email || "—"}</td>
                      <td>{a.website ? <a href={a.website} target="_blank" rel="noopener noreferrer" className="hover-text">{a.website}</a> : "—"}</td>
                      <td>{a._count.contacts}</td>
                      <td>{a._count.deals}</td>
                      <td><button className="link-button hover-text" type="button" onClick={() => openEdit(a)}>Edit</button></td>
                      <td><button className="row-remove" type="button" onClick={() => setDeleteItem(a)}>×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ── Add / Edit Modal ── */}
      {(addOpen || editItem) && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 500, maxHeight: "80vh", overflowY: "auto" }}>
            <h3>{editItem ? "Edit" : "Add"} {tab === "pipeline" ? "Lead" : tab === "contacts" ? "Contact" : "Account"}</h3>

            {tab === "pipeline" && pipelineStage === "COLD_LEAD" && (<>
              <label className="auth-label">Name *</label>
              <input className="input" value={leadForm.name} onChange={e => setLeadForm(p => ({ ...p, name: e.target.value }))} placeholder="Full name" />
              <label className="auth-label">Company *</label>
              <input className="input" value={leadForm.company} onChange={e => setLeadForm(p => ({ ...p, company: e.target.value }))} placeholder="Company name" />
              <label className="auth-label">Email</label>
              <input className="input" type="email" value={leadForm.email} onChange={e => setLeadForm(p => ({ ...p, email: e.target.value }))} placeholder="email@example.com" />
              <label className="auth-label">Phone</label>
              <input className="input" value={leadForm.phone} onChange={e => setLeadForm(p => ({ ...p, phone: e.target.value }))} placeholder="+91" />
              <label className="auth-label">Source</label>
              <select className="input select" value={leadForm.source} onChange={e => setLeadForm(p => ({ ...p, source: e.target.value }))}>
                {LEAD_SOURCES.map(s => <option key={s} value={s}>{sourceLabel[s]}</option>)}
              </select>
              <label className="auth-label">Assigned To</label>
              <select className="input select" value={leadForm.assignedTo} onChange={e => setLeadForm(p => ({ ...p, assignedTo: e.target.value }))}>
                <option value="">Unassigned</option>
                {team.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <label className="auth-label">Notes</label>
              <textarea className="input textarea" rows={2} value={leadForm.notes} onChange={e => setLeadForm(p => ({ ...p, notes: e.target.value }))} placeholder="Optional notes" />
            </>)}

            {tab === "contacts" && (<>
              <label className="auth-label">Name *</label>
              <input className="input" value={contactForm.name} onChange={e => setContactForm(p => ({ ...p, name: e.target.value }))} placeholder="Full name" />
              <label className="auth-label">Email</label>
              <input className="input" type="email" value={contactForm.email} onChange={e => setContactForm(p => ({ ...p, email: e.target.value }))} placeholder="email@example.com" />
              <label className="auth-label">Phone</label>
              <input className="input" value={contactForm.phone} onChange={e => setContactForm(p => ({ ...p, phone: e.target.value }))} placeholder="+91" />
              <label className="auth-label">Company</label>
              <input className="input" value={contactForm.company} onChange={e => setContactForm(p => ({ ...p, company: e.target.value }))} placeholder="Company name" />
              <label className="auth-label">Designation</label>
              <input className="input" value={contactForm.designation} onChange={e => setContactForm(p => ({ ...p, designation: e.target.value }))} placeholder="Job title" />
              <label className="auth-label">Linked Account</label>
              <select className="input select" value={contactForm.accountId} onChange={e => setContactForm(p => ({ ...p, accountId: e.target.value }))}>
                <option value="">None</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.companyName}</option>)}
              </select>
              <label className="auth-label">Notes</label>
              <textarea className="input textarea" rows={2} value={contactForm.notes} onChange={e => setContactForm(p => ({ ...p, notes: e.target.value }))} placeholder="Optional notes" />
            </>)}

            {tab === "accounts" && (<>
              <label className="auth-label">Company Name *</label>
              <input className="input" value={accountForm.companyName} onChange={e => setAccountForm(p => ({ ...p, companyName: e.target.value }))} placeholder="Company name" />
              <label className="auth-label">Industry</label>
              <input className="input" value={accountForm.industry} onChange={e => setAccountForm(p => ({ ...p, industry: e.target.value }))} placeholder="e.g. Events, Hospitality" />
              <label className="auth-label">Phone</label>
              <input className="input" value={accountForm.phone} onChange={e => setAccountForm(p => ({ ...p, phone: e.target.value }))} placeholder="+91" />
              <label className="auth-label">Email</label>
              <input className="input" type="email" value={accountForm.email} onChange={e => setAccountForm(p => ({ ...p, email: e.target.value }))} placeholder="email@company.com" />
              <label className="auth-label">Website</label>
              <input className="input" value={accountForm.website} onChange={e => setAccountForm(p => ({ ...p, website: e.target.value }))} placeholder="https://" />
              <label className="auth-label">Address</label>
              <input className="input" value={accountForm.address} onChange={e => setAccountForm(p => ({ ...p, address: e.target.value }))} placeholder="Office address" />
              <label className="auth-label">Notes</label>
              <textarea className="input textarea" rows={2} value={accountForm.notes} onChange={e => setAccountForm(p => ({ ...p, notes: e.target.value }))} placeholder="Optional notes" />
            </>)}

            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => { setAddOpen(false); setEditItem(null); }}>Cancel</button>
              <button className="btn-primary" type="button" onClick={handleSave}>
                {editItem ? "Save Changes" : addLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirm ── */}
      {deleteItem && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 400 }}>
            <h3>Delete {tab === "contacts" ? "Contact" : "Account"}</h3>
            <p>Are you sure you want to delete <strong>{deleteItem.name || deleteItem.companyName}</strong>? This cannot be undone.</p>
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setDeleteItem(null)}>Cancel</button>
              <button className="btn-primary" type="button" onClick={handleDelete} style={{ background: "var(--red)" }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
