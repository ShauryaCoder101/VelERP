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
  VALUE_PROPOSITION: "Value Proposition", IDENTIFY_DECISION_MAKERS: "Decision Makers",
  PROPOSAL_PRICE_QUOTE: "Proposal/Quote", NEGOTIATION_REVIEW: "Negotiation",
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
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }); }
  catch { return iso; }
};

export default function SalesPage() {
  const [tab, setTab] = useState<Tab>("pipeline");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [team, setTeam] = useState<UserRef[]>([]);

  const [addOpen, setAddOpen] = useState(false);
  const [addTarget, setAddTarget] = useState<"lead" | "contact" | "account">("lead");
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

  const openAddLead = () => { resetForms(); setEditItem(null); setAddTarget("lead"); setAddOpen(true); };
  const openAddContact = () => { resetForms(); setEditItem(null); setAddTarget("contact"); setAddOpen(true); };
  const openAddAccount = () => { resetForms(); setEditItem(null); setAddTarget("account"); setAddOpen(true); };

  const openEdit = (item: any) => {
    setAddOpen(false);
    if (tab === "contacts") { setContactForm({ name: item.name, email: item.email ?? "", phone: item.phone ?? "", company: item.company ?? "", designation: item.designation ?? "", accountId: item.accountId ?? "", notes: item.notes ?? "" }); setAddTarget("contact"); }
    if (tab === "accounts") { setAccountForm({ companyName: item.companyName, industry: item.industry ?? "", phone: item.phone ?? "", email: item.email ?? "", website: item.website ?? "", address: item.address ?? "", notes: item.notes ?? "" }); setAddTarget("account"); }
    setEditItem(item);
  };

  /* ── Pipeline data ── */
  const coldLeads = leads.filter(l => !l.convertedDealId && l.status !== "UNQUALIFIED");
  const totalPipeline = deals.filter(d => !["CLOSED_WON", "CLOSED_LOST"].includes(d.stage)).reduce((s, d) => s + d.amount, 0) || 1;

  const getStageItems = (stage: string) => {
    if (stage === "COLD_LEAD") return coldLeads;
    return deals.filter(d => d.stage === stage);
  };

  const getStageAmount = (stage: string) => {
    if (stage === "COLD_LEAD") return 0;
    return deals.filter(d => d.stage === stage).reduce((s, d) => s + d.amount, 0);
  };

  const getStagePercent = (stage: string) => {
    if (stage === "COLD_LEAD" || stage === "CLOSED_WON" || stage === "CLOSED_LOST") return "";
    const amt = getStageAmount(stage);
    return `${Math.round((amt / totalPipeline) * 100)}%`;
  };

  /* ── CRUD ── */
  const handleSave = async () => {
    const isEdit = !!editItem;
    let url = "";
    let payload: unknown = {};

    if (addTarget === "lead") { url = "/api/sales/leads"; payload = { ...leadForm, status: "NEW" }; }
    if (addTarget === "contact") { url = "/api/sales/contacts"; payload = contactForm; }
    if (addTarget === "account") { url = "/api/sales/accounts"; payload = accountForm; }

    if (isEdit) url += `/${editItem.id}`;

    const res = await fetch(url, {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return;
    const saved = await res.json();

    if (addTarget === "lead") setLeads(prev => [saved, ...prev]);
    if (addTarget === "contact") setContacts(prev => isEdit ? prev.map(x => x.id === saved.id ? saved : x) : [saved, ...prev]);
    if (addTarget === "account") setAccounts(prev => isEdit ? prev.map(x => x.id === saved.id ? saved : x) : [saved, ...prev]);

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

  return (
    <>
      <section className="page-header">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1>Sales</h1>
            <p>Manage your sales pipeline, contacts, and accounts.</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {tab === "pipeline" && <button className="btn-primary" type="button" onClick={openAddLead}>+ Add Lead</button>}
            {tab === "contacts" && <button className="btn-primary" type="button" onClick={openAddContact}>+ Add Contact</button>}
            {tab === "accounts" && <button className="btn-primary" type="button" onClick={openAddAccount}>+ Add Account</button>}
          </div>
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

      {/* ════ Pipeline Tab — Kanban Board ════ */}
      {tab === "pipeline" && (
        <div className="kanban-board">
          {PIPELINE_STAGES.map(stage => {
            const items = getStageItems(stage);
            const amount = getStageAmount(stage);
            const pct = getStagePercent(stage);
            const color = stageColor[stage];

            return (
              <div key={stage} className="kanban-column">
                {/* Column header */}
                <div className="kanban-col-header" style={{ borderTopColor: color }}>
                  <div className="kanban-col-title">
                    <span>{stageLabel[stage]}</span>
                    <span className="kanban-col-badge" style={{ background: `${color}20`, color }}>{items.length}</span>
                    {pct && <span className="kanban-col-pct">· {pct}</span>}
                  </div>
                  {stage !== "COLD_LEAD" && amount > 0 && (
                    <div className="kanban-col-amount">₹{amount.toLocaleString("en-IN")}</div>
                  )}
                </div>

                {/* Cards */}
                <div className="kanban-cards">
                  {items.length === 0 && <div className="kanban-empty">No items</div>}

                  {stage === "COLD_LEAD"
                    ? (items as Lead[]).map(lead => (
                      <Link key={lead.id} href={`/sales/leads/${lead.id}`} className="kanban-card">
                        <div className="kanban-card-name">{lead.name}</div>
                        <div className="kanban-card-stage" style={{ color }}>{stageLabel[stage]}</div>
                        <div className="kanban-card-row">{lead.company}</div>
                        {lead.assignedToUser && <div className="kanban-card-row">{lead.assignedToUser.name}</div>}
                        {lead.email && <div className="kanban-card-row">{lead.email}</div>}
                        <div className="kanban-card-footer">
                          <span className="kanban-card-date">{fmt(lead.createdAt)}</span>
                        </div>
                      </Link>
                    ))
                    : (items as Deal[]).map(deal => (
                      <Link key={deal.id} href={`/sales/deals/${deal.id}`} className="kanban-card">
                        <div className="kanban-card-name">{deal.dealName}</div>
                        <div className="kanban-card-stage" style={{ color }}>{stageLabel[stage]}</div>
                        {deal.account && <div className="kanban-card-row">{deal.account.companyName}</div>}
                        {deal.assignedToUser && <div className="kanban-card-row">{deal.assignedToUser.name}</div>}
                        <div className="kanban-card-amount">₹{deal.amount.toLocaleString("en-IN")}</div>
                        <div className="kanban-card-footer">
                          <span className="kanban-card-date">{fmt(deal.createdAt)}</span>
                        </div>
                      </Link>
                    ))
                  }
                </div>
              </div>
            );
          })}
        </div>
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
            <h3>{editItem ? "Edit" : "Add"} {addTarget === "lead" ? "Lead" : addTarget === "contact" ? "Contact" : "Account"}</h3>

            {addTarget === "lead" && (<>
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

            {addTarget === "contact" && (<>
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

            {addTarget === "account" && (<>
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
                {editItem ? "Save Changes" : `Add ${addTarget === "lead" ? "Lead" : addTarget === "contact" ? "Contact" : "Account"}`}
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
