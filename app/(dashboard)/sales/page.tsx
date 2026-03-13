"use client";

import { useEffect, useState } from "react";

/* ── Types ── */
type UserRef = { id: string; name: string };
type AccountRef = { id: string; companyName: string };

type Lead = {
  id: string; name: string; company: string; email: string | null; phone: string | null;
  source: string; status: string; notes: string | null; assignedTo: string | null;
  assignedToUser: UserRef | null; createdAt: string;
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
type Tab = "leads" | "contacts" | "accounts" | "deals";
const TABS: { key: Tab; label: string }[] = [
  { key: "leads", label: "Leads" },
  { key: "contacts", label: "Contacts" },
  { key: "accounts", label: "Accounts" },
  { key: "deals", label: "Deals" }
];

const LEAD_SOURCES = ["WEBSITE", "REFERRAL", "SOCIAL_MEDIA", "COLD_CALL", "EVENT", "OTHER"];
const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "UNQUALIFIED"];
const DEAL_STAGES = ["QUALIFICATION", "PROPOSAL", "NEGOTIATION", "CLOSED_WON", "CLOSED_LOST"];

const sourceLabel: Record<string, string> = { WEBSITE: "Website", REFERRAL: "Referral", SOCIAL_MEDIA: "Social Media", COLD_CALL: "Cold Call", EVENT: "Event", OTHER: "Other" };
const leadStatusLabel: Record<string, string> = { NEW: "New", CONTACTED: "Contacted", QUALIFIED: "Qualified", UNQUALIFIED: "Unqualified" };
const leadStatusColor: Record<string, string> = { NEW: "#3b82f6", CONTACTED: "#e89b0c", QUALIFIED: "#16b65f", UNQUALIFIED: "#6b7280" };
const stageLabel: Record<string, string> = { QUALIFICATION: "Qualification", PROPOSAL: "Proposal", NEGOTIATION: "Negotiation", CLOSED_WON: "Closed Won", CLOSED_LOST: "Closed Lost" };
const stageColor: Record<string, string> = { QUALIFICATION: "#3b82f6", PROPOSAL: "#8b5cf6", NEGOTIATION: "#e89b0c", CLOSED_WON: "#16b65f", CLOSED_LOST: "#6b7280" };

const fmt = (iso: string) => {
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return iso; }
};

export default function SalesPage() {
  const [tab, setTab] = useState<Tab>("leads");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [team, setTeam] = useState<UserRef[]>([]);

  const [addOpen, setAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [deleteItem, setDeleteItem] = useState<any>(null);

  /* ── Form states ── */
  const [leadForm, setLeadForm] = useState({ name: "", company: "", email: "", phone: "", source: "OTHER", status: "NEW", notes: "", assignedTo: "" });
  const [contactForm, setContactForm] = useState({ name: "", email: "", phone: "", company: "", designation: "", accountId: "", notes: "" });
  const [accountForm, setAccountForm] = useState({ companyName: "", industry: "", phone: "", email: "", website: "", address: "", notes: "" });
  const [dealForm, setDealForm] = useState({ dealName: "", accountId: "", stage: "QUALIFICATION", amount: "", expectedCloseDate: "", notes: "", assignedTo: "" });

  /* ── Load data ── */
  useEffect(() => {
    fetch("/api/sales/leads").then(r => r.json()).then(setLeads).catch(() => {});
    fetch("/api/sales/contacts").then(r => r.json()).then(setContacts).catch(() => {});
    fetch("/api/sales/accounts").then(r => r.json()).then(setAccounts).catch(() => {});
    fetch("/api/sales/deals").then(r => r.json()).then(setDeals).catch(() => {});
    fetch("/api/team").then(r => r.json()).then((d: any[]) => setTeam(d.map(u => ({ id: u.id, name: u.name })))).catch(() => {});
  }, []);

  /* ── Helpers ── */
  const resetForms = () => {
    setLeadForm({ name: "", company: "", email: "", phone: "", source: "OTHER", status: "NEW", notes: "", assignedTo: "" });
    setContactForm({ name: "", email: "", phone: "", company: "", designation: "", accountId: "", notes: "" });
    setAccountForm({ companyName: "", industry: "", phone: "", email: "", website: "", address: "", notes: "" });
    setDealForm({ dealName: "", accountId: "", stage: "QUALIFICATION", amount: "", expectedCloseDate: "", notes: "", assignedTo: "" });
  };

  const openAdd = () => { resetForms(); setEditItem(null); setAddOpen(true); };

  const openEdit = (item: any) => {
    setAddOpen(false);
    if (tab === "leads") setLeadForm({ name: item.name, company: item.company, email: item.email ?? "", phone: item.phone ?? "", source: item.source, status: item.status, notes: item.notes ?? "", assignedTo: item.assignedTo ?? "" });
    if (tab === "contacts") setContactForm({ name: item.name, email: item.email ?? "", phone: item.phone ?? "", company: item.company ?? "", designation: item.designation ?? "", accountId: item.accountId ?? "", notes: item.notes ?? "" });
    if (tab === "accounts") setAccountForm({ companyName: item.companyName, industry: item.industry ?? "", phone: item.phone ?? "", email: item.email ?? "", website: item.website ?? "", address: item.address ?? "", notes: item.notes ?? "" });
    if (tab === "deals") setDealForm({ dealName: item.dealName, accountId: item.accountId ?? "", stage: item.stage, amount: String(item.amount), expectedCloseDate: item.expectedCloseDate?.slice(0, 10) ?? "", notes: item.notes ?? "", assignedTo: item.assignedTo ?? "" });
    setEditItem(item);
  };

  /* ── CRUD handlers ── */
  const handleSave = async () => {
    const isEdit = !!editItem;
    let url = "";
    let payload: unknown = {};

    if (tab === "leads") { url = "/api/sales/leads"; payload = leadForm; }
    if (tab === "contacts") { url = "/api/sales/contacts"; payload = contactForm; }
    if (tab === "accounts") { url = "/api/sales/accounts"; payload = accountForm; }
    if (tab === "deals") { url = "/api/sales/deals"; payload = dealForm; }

    if (isEdit) url += `/${editItem.id}`;

    const res = await fetch(url, {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return;
    const saved = await res.json();

    if (tab === "leads") setLeads(prev => isEdit ? prev.map(x => x.id === saved.id ? saved : x) : [saved, ...prev]);
    if (tab === "contacts") setContacts(prev => isEdit ? prev.map(x => x.id === saved.id ? saved : x) : [saved, ...prev]);
    if (tab === "accounts") setAccounts(prev => isEdit ? prev.map(x => x.id === saved.id ? saved : x) : [saved, ...prev]);
    if (tab === "deals") setDeals(prev => isEdit ? prev.map(x => x.id === saved.id ? saved : x) : [saved, ...prev]);

    setAddOpen(false);
    setEditItem(null);
    resetForms();
  };

  const handleDelete = async () => {
    if (!deleteItem) return;
    let url = "";
    if (tab === "leads") url = `/api/sales/leads/${deleteItem.id}`;
    if (tab === "contacts") url = `/api/sales/contacts/${deleteItem.id}`;
    if (tab === "accounts") url = `/api/sales/accounts/${deleteItem.id}`;
    if (tab === "deals") url = `/api/sales/deals/${deleteItem.id}`;

    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) return;

    if (tab === "leads") setLeads(prev => prev.filter(x => x.id !== deleteItem.id));
    if (tab === "contacts") setContacts(prev => prev.filter(x => x.id !== deleteItem.id));
    if (tab === "accounts") setAccounts(prev => prev.filter(x => x.id !== deleteItem.id));
    if (tab === "deals") setDeals(prev => prev.filter(x => x.id !== deleteItem.id));
    setDeleteItem(null);
  };

  const tabTitle = tab === "leads" ? "Leads" : tab === "contacts" ? "Contacts" : tab === "accounts" ? "Accounts" : "Deals";

  /* ── Pipeline summary for deals ── */
  const pipeline = deals.filter(d => !["CLOSED_WON", "CLOSED_LOST"].includes(d.stage)).reduce((s, d) => s + d.amount, 0);
  const wonTotal = deals.filter(d => d.stage === "CLOSED_WON").reduce((s, d) => s + d.amount, 0);

  return (
    <>
      <section className="page-header">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1>Sales</h1>
            <p>Manage your leads, contacts, accounts, and deals.</p>
          </div>
          <button className="btn-primary" type="button" onClick={openAdd}>+ Add {tabTitle.slice(0, -1)}</button>
        </div>
      </section>

      {/* Tabs */}
      <div className="sales-tabs">
        {TABS.map(t => (
          <button key={t.key} type="button" className={`sales-tab ${tab === t.key ? "sales-tab-active" : ""}`}
            onClick={() => { setTab(t.key); setAddOpen(false); setEditItem(null); }}>
            {t.label}
            <span className="sales-tab-count">
              {t.key === "leads" ? leads.length : t.key === "contacts" ? contacts.length : t.key === "accounts" ? accounts.length : deals.length}
            </span>
          </button>
        ))}
      </div>

      {/* Deals pipeline bar */}
      {tab === "deals" && (
        <div className="sales-pipeline">
          <div className="sales-pipeline-item">
            <span className="muted">Pipeline</span>
            <strong>₹{pipeline.toLocaleString("en-IN")}</strong>
          </div>
          <div className="sales-pipeline-item">
            <span className="muted">Won</span>
            <strong style={{ color: "#16b65f" }}>₹{wonTotal.toLocaleString("en-IN")}</strong>
          </div>
          <div className="sales-pipeline-item">
            <span className="muted">Deals</span>
            <strong>{deals.length}</strong>
          </div>
        </div>
      )}

      {/* Table */}
      <section className="panel">
        <div className="panel-body">
          <div className="table-wrap">
            {tab === "leads" && (
              <table className="claims-table">
                <thead><tr><th>S.No</th><th>Name</th><th>Company</th><th>Email</th><th>Phone</th><th>Source</th><th>Status</th><th>Assigned To</th><th /><th /></tr></thead>
                <tbody>
                  {leads.length === 0 ? <tr><td colSpan={10} className="empty-state">No leads yet.</td></tr> : leads.map((l, i) => (
                    <tr key={l.id}>
                      <td>{i + 1}</td>
                      <td><strong>{l.name}</strong></td>
                      <td>{l.company}</td>
                      <td>{l.email || "—"}</td>
                      <td>{l.phone || "—"}</td>
                      <td>{sourceLabel[l.source] ?? l.source}</td>
                      <td><span className="phase-pill" style={{ background: `${leadStatusColor[l.status]}18`, color: leadStatusColor[l.status] }}>{leadStatusLabel[l.status]}</span></td>
                      <td>{l.assignedToUser?.name || "—"}</td>
                      <td><button className="link-button hover-text" type="button" onClick={() => openEdit(l)}>Edit</button></td>
                      <td><button className="row-remove" type="button" onClick={() => setDeleteItem(l)}>×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {tab === "contacts" && (
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
            )}

            {tab === "accounts" && (
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
            )}

            {tab === "deals" && (
              <table className="claims-table">
                <thead><tr><th>S.No</th><th>Deal Name</th><th>Account</th><th>Stage</th><th>Amount</th><th>Expected Close</th><th>Assigned To</th><th /><th /></tr></thead>
                <tbody>
                  {deals.length === 0 ? <tr><td colSpan={9} className="empty-state">No deals yet.</td></tr> : deals.map((d, i) => (
                    <tr key={d.id}>
                      <td>{i + 1}</td>
                      <td><strong>{d.dealName}</strong></td>
                      <td>{d.account?.companyName || "—"}</td>
                      <td><span className="phase-pill" style={{ background: `${stageColor[d.stage]}18`, color: stageColor[d.stage] }}>{stageLabel[d.stage]}</span></td>
                      <td style={{ fontWeight: 600 }}>₹{d.amount.toLocaleString("en-IN")}</td>
                      <td>{d.expectedCloseDate ? fmt(d.expectedCloseDate) : "—"}</td>
                      <td>{d.assignedToUser?.name || "—"}</td>
                      <td><button className="link-button hover-text" type="button" onClick={() => openEdit(d)}>Edit</button></td>
                      <td><button className="row-remove" type="button" onClick={() => setDeleteItem(d)}>×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      {/* ── Add / Edit Modal ── */}
      {(addOpen || editItem) && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 500, maxHeight: "80vh", overflowY: "auto" }}>
            <h3>{editItem ? `Edit ${tabTitle.slice(0, -1)}` : `Add ${tabTitle.slice(0, -1)}`}</h3>

            {tab === "leads" && (<>
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
              <label className="auth-label">Status</label>
              <select className="input select" value={leadForm.status} onChange={e => setLeadForm(p => ({ ...p, status: e.target.value }))}>
                {LEAD_STATUSES.map(s => <option key={s} value={s}>{leadStatusLabel[s]}</option>)}
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

            {tab === "deals" && (<>
              <label className="auth-label">Deal Name *</label>
              <input className="input" value={dealForm.dealName} onChange={e => setDealForm(p => ({ ...p, dealName: e.target.value }))} placeholder="Deal name" />
              <label className="auth-label">Account</label>
              <select className="input select" value={dealForm.accountId} onChange={e => setDealForm(p => ({ ...p, accountId: e.target.value }))}>
                <option value="">None</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.companyName}</option>)}
              </select>
              <label className="auth-label">Stage</label>
              <select className="input select" value={dealForm.stage} onChange={e => setDealForm(p => ({ ...p, stage: e.target.value }))}>
                {DEAL_STAGES.map(s => <option key={s} value={s}>{stageLabel[s]}</option>)}
              </select>
              <label className="auth-label">Amount (₹)</label>
              <input className="input" type="number" value={dealForm.amount} onChange={e => setDealForm(p => ({ ...p, amount: e.target.value }))} placeholder="0" />
              <label className="auth-label">Expected Close Date</label>
              <input className="input" type="date" value={dealForm.expectedCloseDate} onChange={e => setDealForm(p => ({ ...p, expectedCloseDate: e.target.value }))} />
              <label className="auth-label">Assigned To</label>
              <select className="input select" value={dealForm.assignedTo} onChange={e => setDealForm(p => ({ ...p, assignedTo: e.target.value }))}>
                <option value="">Unassigned</option>
                {team.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <label className="auth-label">Notes</label>
              <textarea className="input textarea" rows={2} value={dealForm.notes} onChange={e => setDealForm(p => ({ ...p, notes: e.target.value }))} placeholder="Optional notes" />
            </>)}

            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => { setAddOpen(false); setEditItem(null); }}>Cancel</button>
              <button className="btn-primary" type="button" onClick={handleSave}>
                {editItem ? "Save Changes" : `Add ${tabTitle.slice(0, -1)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirm ── */}
      {deleteItem && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 400 }}>
            <h3>Delete {tabTitle.slice(0, -1)}</h3>
            <p>Are you sure you want to delete <strong>{deleteItem.name || deleteItem.companyName || deleteItem.dealName}</strong>? This cannot be undone.</p>
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
