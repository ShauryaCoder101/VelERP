"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

type UploadItem = {
  id: string;
  fileUrl: string;
  fileType: string;
  createdAt: string;
  user: { id: string; name: string };
};

type ExpenseItemRow = {
  id: string;
  eventName: string;
  location: string;
  type: string;
  date: string;
  amount: number;
};

type ClaimAttachment = {
  id: string;
  fileUrl: string;
  fileType: string;
};

type ClaimItem = {
  id: string;
  status: string;
  createdAt: string;
  user: { id: string; name: string; designation: string };
  items: ExpenseItemRow[];
  attachments: ClaimAttachment[];
};

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
  costSheetUrl: string | null;
  closingSheetUrl: string | null;
  createdBy: string | null;
  vendors: { vendor: { id: string; companyName: string; phone: string; work: string; location?: string; gstin?: string; panCard?: string; pocName?: string } }[];
  artists: { artist: { id: string; name: string; phone: string; category: string; location?: string; socialLink?: string } }[];
  teamMembers: { user: { id: string; name: string; designation: string; email: string } }[];
  uploads: UploadItem[];
  claims: ClaimItem[];
  finances: any[];
};

type VendorOption = { id: string; companyName: string };
type ArtistOption = { id: string; name: string };
type TeamOption = { id: string; name: string; designation: string };

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

const isImage = (type: string) => type.startsWith("image/");

/* ── Skeleton Components ── */
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

const SkeletonPeople = ({ count = 3 }: { count?: number }) => (
  <section className="skeleton-panel">
    <div className="skeleton skeleton-panel-header" />
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="skeleton-person">
        <div className="skeleton skeleton-avatar" />
        <div className="skeleton-person-text">
          <div className="skeleton" style={{ width: "60%", height: 14 }} />
          <div className="skeleton" style={{ width: "40%", height: 12 }} />
        </div>
      </div>
    ))}
  </section>
);

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const costSheetRef = useRef<HTMLInputElement>(null);
  const closingSheetRef = useRef<HTMLInputElement>(null);

  const [ev, setEv] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [billPreviewUrl, setBillPreviewUrl] = useState<string | null>(null);
  const [loadingBillPreview, setLoadingBillPreview] = useState(false);
  const [costSheetUploading, setCostSheetUploading] = useState(false);
  const [closingSheetUploading, setClosingSheetUploading] = useState(false);

  const [currentUser, setCurrentUser] = useState<{ id: string; role: string } | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [allVendors, setAllVendors] = useState<VendorOption[]>([]);
  const [allArtists, setAllArtists] = useState<ArtistOption[]>([]);
  const [allTeam, setAllTeam] = useState<TeamOption[]>([]);
  const [editVendorIds, setEditVendorIds] = useState<string[]>([]);
  const [editArtistIds, setEditArtistIds] = useState<string[]>([]);
  const [editTeamIds, setEditTeamIds] = useState<string[]>([]);
  const [editSaving, setEditSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // Finance state
  const [finances, setFinances] = useState<FinanceRow[]>([]);
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

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.ok ? r.json() : null).then((u) => u && setCurrentUser({ id: u.id, role: u.role })).catch(() => {});
  }, []);

  // Check if current user is a team member of this event
  const isTeamMember = ev && currentUser && (
    currentUser.role === "Managing Director" ||
    ev.teamMembers.some((tm) => tm.user.id === currentUser.id)
  );

  const openEdit = () => {
    if (!ev) return;
    setEditVendorIds(ev.vendors.map((v) => v.vendor.id));
    setEditArtistIds(ev.artists.map((a) => a.artist.id));
    setEditTeamIds(ev.teamMembers.map((t) => t.user.id));
    Promise.all([
      fetch("/api/vendors").then((r) => r.json()).then((d: any[]) => setAllVendors(d.map((v) => ({ id: v.id, companyName: v.companyName })))),
      fetch("/api/artists").then((r) => r.json()).then((d: any[]) => setAllArtists(d.map((a) => ({ id: a.id, name: a.name })))),
      fetch("/api/team").then((r) => r.json()).then((d: any[]) => setAllTeam(d.map((t) => ({ id: t.id, name: t.name, designation: t.designation }))))
    ]).catch(() => {});
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!ev) return;
    setEditSaving(true);
    await fetch(`/api/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendorIds: editVendorIds, artistIds: editArtistIds, teamMemberIds: editTeamIds })
    });
    setEditOpen(false);
    setEditSaving(false);
    loadEvent();
  };

  const handleDelete = async () => {
    if (!ev) return;
    const res = await fetch(`/api/events/${ev.id}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/events");
    } else {
      const msg = await res.text();
      alert(msg || "Failed to delete event");
    }
    setDeleteConfirm(false);
  };

  const canDelete = currentUser && ev && (
    currentUser.role === "MANAGING_DIRECTOR" || ev.createdBy === currentUser.id
  );

  const handleUpload = async (files: FileList) => {
    if (!files.length || !ev) return;
    setUploading(true);
    const total = files.length;

    for (let i = 0; i < total; i++) {
      const file = files[i];
      setUploadProgress(`Uploading ${i + 1} of ${total}: ${file.name}`);

      try {
        const presignRes = await fetch("/api/uploads/presign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, fileType: file.type, eventId: ev.id })
        });
        if (!presignRes.ok) { setUploadProgress(`Failed to get upload URL for ${file.name}`); continue; }
        const { uploadUrl, fileUrl } = await presignRes.json();

        await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });

        await fetch("/api/uploads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId: ev.id, fileUrl, fileType: file.type })
        });
      } catch {
        setUploadProgress(`Error uploading ${file.name}`);
      }
    }

    setUploading(false);
    setUploadProgress("");
    if (fileRef.current) fileRef.current.value = "";
    loadEvent();
  };

  const handleSheetUpload = async (file: File, type: "cost-sheet" | "closing-sheet") => {
    if (!ev) return;
    const setter = type === "cost-sheet" ? setCostSheetUploading : setClosingSheetUploading;
    setter(true);
    try {
      const presignRes = await fetch("/api/uploads/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, fileType: file.type, eventId: ev.id })
      });
      if (!presignRes.ok) { setter(false); return; }
      const { uploadUrl, fileUrl } = await presignRes.json();
      await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });

      const field = type === "cost-sheet" ? "costSheetUrl" : "closingSheetUrl";
      await fetch(`/api/events/${ev.id}/${type}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: fileUrl })
      });
      loadEvent();
    } catch { /* ignore */ }
    setter(false);
    if (type === "cost-sheet" && costSheetRef.current) costSheetRef.current.value = "";
    if (type === "closing-sheet" && closingSheetRef.current) closingSheetRef.current.value = "";
  };

  const handleRemoveCostSheet = async () => {
    if (!ev) return;
    setCostSheetUploading(true);
    await fetch(`/api/events/${ev.id}/cost-sheet`, { method: "DELETE" });
    loadEvent();
    setCostSheetUploading(false);
  };

  // Bill preview handler
  const openBillUrl = async (rawUrl: string, mode: "preview" | "tab") => {
    try {
      setLoadingBillPreview(true);
      const res = await fetch(`/api/uploads/view?url=${encodeURIComponent(rawUrl)}`);
      if (!res.ok) throw new Error("Failed to get signed URL");
      const { signedUrl } = await res.json();
      if (mode === "preview") {
        setBillPreviewUrl(signedUrl);
      } else {
        window.open(signedUrl, "_blank");
      }
    } catch (err) {
      console.error(err);
      alert("Could not load the bill. Please try again.");
    } finally {
      setLoadingBillPreview(false);
    }
  };

  const isBillImage = (fileType: string) => fileType.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(fileType);

  // Finance handlers
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
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = row;
        return next;
      }
      return [...prev, row];
    });
    setFinanceEditId(null);
  };

  const closeVendorPayment = async (vendorId: string) => {
    if (!ev) return;
    const res = await fetch(`/api/events/${ev.id}/finance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendorId, closed: true })
    });
    if (!res.ok) return;
    setFinances((prev) =>
      prev.map((f) => f.vendorId === vendorId ? { ...f, closed: true } : f)
    );
  };

  const reopenVendorPayment = async (vendorId: string) => {
    if (!ev) return;
    const res = await fetch(`/api/events/${ev.id}/finance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendorId, closed: false })
    });
    if (!res.ok) return;
    setFinances((prev) =>
      prev.map((f) => f.vendorId === vendorId ? { ...f, closed: false } : f)
    );
  };

  // Loading skeleton
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
          <SkeletonPeople count={3} />
          <SkeletonPeople count={2} />
          <SkeletonPeople count={2} />
        </div>
        <section className="skeleton-panel" style={{ marginTop: 16 }}>
          <div className="skeleton skeleton-panel-header" style={{ width: 200 }} />
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton-table-row">
              <span className="skeleton skeleton-cell" />
              <span className="skeleton skeleton-cell" />
              <span className="skeleton skeleton-cell" />
              <span className="skeleton skeleton-cell" />
            </div>
          ))}
        </section>
      </>
    );
  }

  if (!ev) return <p style={{ padding: 32 }}>Event not found.</p>;

  const phase = phaseLabel(ev.phase);
  const color = phaseColor(ev.phase);
  const photos = ev.uploads.filter((u) => isImage(u.fileType));
  const otherFiles = ev.uploads.filter((u) => !isImage(u.fileType));

  // Build finance data for all event vendors
  const financeMap = new Map(finances.map((f) => [f.vendorId, f]));
  const allEventVendors = ev.vendors.map((v) => {
    const f = financeMap.get(v.vendor.id);
    return {
      vendorId: v.vendor.id,
      vendorName: v.vendor.companyName,
      vendorWork: v.vendor.work,
      quotedAmount: f?.quotedAmount ?? 0,
      advancePaid: f?.advancePaid ?? 0,
      totalPaid: f?.totalPaid ?? 0,
      closed: f?.closed ?? false,
      notes: f?.notes ?? "",
      hasFinance: !!f
    };
  });

  const totalQuoted = allEventVendors.reduce((s, v) => s + v.quotedAmount, 0);
  const totalAdvance = allEventVendors.reduce((s, v) => s + v.advancePaid, 0);
  const totalPaidAll = allEventVendors.reduce((s, v) => s + v.totalPaid, 0);
  const totalBalance = totalQuoted - totalPaidAll;

  return (
    <>
      <section className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button className="btn-outline hover-text" type="button" onClick={() => router.push("/events")} style={{ padding: "6px 14px" }}>
            ← Back
          </button>
          <div style={{ flex: 1, minWidth: 180 }}>
            <h1>{ev.eventName}</h1>
            <p>{ev.companyName}</p>
          </div>
          <button className="btn-outline hover-text" type="button" onClick={openEdit} style={{ padding: "6px 14px" }}>Edit Team / Vendors / Artists</button>
          {canDelete && (
            <button className="btn-outline hover-text" type="button" onClick={() => setDeleteConfirm(true)}
              style={{ padding: "6px 14px", color: "var(--red)", borderColor: "var(--red)" }}>Delete Event</button>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
            <span className="phase-pill" style={{ background: `${color}18`, color }}>{phase}</span>

            <input ref={costSheetRef} type="file" accept=".pdf,.xlsx,.xls,.csv,.doc,.docx" style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && handleSheetUpload(e.target.files[0], "cost-sheet")} />

            {ev.costSheetUrl ? (
              <>
                <a href={ev.costSheetUrl} target="_blank" rel="noopener noreferrer" className="btn-outline hover-text" style={{ padding: "6px 14px", display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Cost Sheet
                </a>
                <button className="btn-outline hover-text" type="button" disabled={costSheetUploading}
                  onClick={() => costSheetRef.current?.click()} style={{ padding: "6px 14px" }}>
                  {costSheetUploading ? "Uploading…" : "Update"}
                </button>
                <button className="btn-outline hover-text" type="button" onClick={handleRemoveCostSheet}
                  style={{ padding: "6px 14px", color: "var(--red)" }}>
                  Remove
                </button>
              </>
            ) : (
              <button className="btn-primary" type="button" disabled={costSheetUploading}
                onClick={() => costSheetRef.current?.click()} style={{ padding: "6px 14px", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                {costSheetUploading ? "Uploading…" : "Upload Cost Sheet"}
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="event-detail-grid">
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

        <section className="panel">
          <div className="panel-header"><h2>Velocity Team Members</h2></div>
          <div className="panel-body">
            {ev.teamMembers.length === 0 ? (
              <p className="muted">No team members linked.</p>
            ) : (
              <div className="detail-people-list">
                {ev.teamMembers.map((tm) => (
                  <div key={tm.user.id} className="detail-person-card">
                    <div className="avatar" style={{ width: 36, height: 36, fontSize: 14 }}>{tm.user.name.charAt(0)}</div>
                    <div>
                      <strong>{tm.user.name}</strong>
                      <span className="muted">{tm.user.designation}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

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

        <section className="panel">
          <div className="panel-header"><h2>Artists Involved</h2></div>
          <div className="panel-body">
            {ev.artists.length === 0 ? (
              <p className="muted">No artists linked.</p>
            ) : (
              <div className="detail-people-list">
                {ev.artists.map((a) => (
                  <div key={a.artist.id} className="detail-person-card">
                    <div className="avatar" style={{ width: 36, height: 36, fontSize: 14, background: "#8b5cf6" }}>{a.artist.name.charAt(0)}</div>
                    <div>
                      <strong>{a.artist.name}</strong>
                      <span className="muted">{a.artist.category}{a.artist.location ? ` · ${a.artist.location}` : ""}</span>
                      {a.artist.phone && <span className="muted">{a.artist.phone}</span>}
                      {a.artist.socialLink && <Link href={a.artist.socialLink} target="_blank" className="muted hover-text">{a.artist.socialLink}</Link>}
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
              <p className="muted">Track negotiated amounts, advance payments, and balances for each vendor.</p>
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
                    {isTeamMember && <th>Actions</th>}
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
                        {isTeamMember && (
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
                        )}
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
                      {isTeamMember && <td />}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Expense Claims section - full width */}
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-header claims-header">
          <h2>Expense Claims</h2>
          <span className="muted">{ev.claims.length} claim{ev.claims.length !== 1 ? "s" : ""} · ₹{ev.claims.reduce((sum, c) => sum + c.items.reduce((s, i) => s + i.amount, 0), 0).toLocaleString("en-IN")}</span>
        </div>
        <div className="panel-body">
          {ev.claims.length === 0 ? (
            <div className="empty-state">No expense claims filed for this event.</div>
          ) : (
            <div className="table-wrap">
              <table className="claims-table">
                <thead>
                  <tr>
                    <th>Filed By</th>
                    <th>Status</th>
                    <th>Items</th>
                    <th>Total Amount</th>
                    <th>Bill / Receipt</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {ev.claims.map((claim) => {
                    const total = claim.items.reduce((s, i) => s + i.amount, 0);
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
                        <td>{claim.items.length} item{claim.items.length !== 1 ? "s" : ""}</td>
                        <td style={{ fontWeight: 600 }}>₹{total.toLocaleString("en-IN")}</td>
                        <td>
                          {claim.attachments && claim.attachments.length > 0 ? (
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              {claim.attachments.map((att) => (
                                isBillImage(att.fileType) ? (
                                  <button
                                    key={att.id}
                                    type="button"
                                    className="finance-edit-btn"
                                    disabled={loadingBillPreview}
                                    onClick={() => openBillUrl(att.fileUrl, "preview")}
                                    style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                                  >
                                    {loadingBillPreview ? "⏳" : "🖼"} View
                                  </button>
                                ) : (
                                  <button
                                    key={att.id}
                                    type="button"
                                    className="finance-edit-btn"
                                    disabled={loadingBillPreview}
                                    onClick={() => openBillUrl(att.fileUrl, "tab")}
                                    style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                                  >
                                    {loadingBillPreview ? "⏳" : "📄"} View PDF
                                  </button>
                                )
                              ))}
                            </div>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
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

      {/* Upload & Photos section - full width */}
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-header claims-header">
          <h2>Event Photos & Files</h2>
          <div className="claims-actions" style={{ gap: 10 }}>
            {uploadProgress && <span className="muted">{uploadProgress}</span>}
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx"
              style={{ display: "none" }}
              onChange={(e) => e.target.files && handleUpload(e.target.files)}
            />
            <button
              className="btn-primary"
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? "Uploading…" : "Upload Photos"}
            </button>
          </div>
        </div>
        <div className="panel-body">
          {ev.uploads.length === 0 ? (
            <div className="empty-state">No photos or files uploaded yet.</div>
          ) : (
            <>
              {photos.length > 0 && (
                <div className="photo-gallery">
                  {photos.map((p) => (
                    <button key={p.id} type="button" className="photo-thumb" onClick={() => setLightbox(p.fileUrl)}>
                      <img src={p.fileUrl} alt="Event photo" loading="lazy" />
                      <div className="photo-thumb-info">
                        <span className="muted">{p.user.name}</span>
                        <span className="muted">{fmt(p.createdAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {otherFiles.length > 0 && (
                <div style={{ marginTop: photos.length > 0 ? 16 : 0 }}>
                  <h4 style={{ marginBottom: 8 }}>Other Files</h4>
                  <div className="detail-people-list">
                    {otherFiles.map((f) => (
                      <a key={f.id} href={f.fileUrl} target="_blank" rel="noopener noreferrer" className="detail-person-card hover-text">
                        <div className="avatar" style={{ width: 36, height: 36, fontSize: 14, background: "#6b7280" }}>
                          {f.fileType.split("/")[1]?.slice(0, 3).toUpperCase() ?? "FILE"}
                        </div>
                        <div>
                          <strong>{f.fileUrl.split("/").pop()}</strong>
                          <span className="muted">{f.user.name} · {fmt(f.createdAt)}</span>
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Closing Sheet - bottom */}
      <section className="panel closing-sheet-panel" style={{ marginTop: 16 }}>
        <div className="panel-header claims-header">
          <div>
            <h2>Closing Sheet</h2>
            <p className="muted">Uploading a closing sheet will mark this event as Finished.</p>
          </div>
        </div>
        <div className="panel-body">
          <input ref={closingSheetRef} type="file" accept=".pdf,.xlsx,.xls,.csv,.doc,.docx" style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && handleSheetUpload(e.target.files[0], "closing-sheet")} />

          {ev.closingSheetUrl ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="detail-person-card" style={{ flex: 1 }}>
                <div className="avatar" style={{ width: 36, height: 36, fontSize: 14, background: "#16b65f" }}>✓</div>
                <div>
                  <strong>Closing sheet uploaded</strong>
                  <span className="muted">This event has been marked as Finished.</span>
                </div>
              </div>
              <a href={ev.closingSheetUrl} target="_blank" rel="noopener noreferrer" className="btn-outline hover-text"
                style={{ padding: "8px 16px", display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Download
              </a>
            </div>
          ) : (
            <div className="closing-sheet-cta">
              <p style={{ marginBottom: 12 }}>No closing sheet has been added yet. Once uploaded, the event phase will automatically change to <strong>Finished</strong>.</p>
              <button className="btn-primary" type="button" disabled={closingSheetUploading}
                onClick={() => closingSheetRef.current?.click()}
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                {closingSheetUploading ? "Uploading…" : "Upload Closing Sheet"}
              </button>
            </div>
          )}
        </div>
      </section>

      {lightbox && (
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={() => setLightbox(null)}>
          <div className="lightbox-container" onClick={(e) => e.stopPropagation()}>
            <button className="lightbox-close" type="button" onClick={() => setLightbox(null)}>×</button>
            <img src={lightbox} alt="Full size" className="lightbox-img" />
          </div>
        </div>
      )}

      {/* Bill Preview Modal */}
      {billPreviewUrl && (
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={() => setBillPreviewUrl(null)}>
          <div className="modal-card" style={{ maxWidth: 720, padding: 16 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>Bill / Receipt</h3>
              <div style={{ display: "flex", gap: 8 }}>
                <a href={billPreviewUrl} target="_blank" rel="noopener noreferrer" className="btn-outline hover-text" style={{ padding: "6px 14px", textDecoration: "none", fontSize: 13 }}>
                  Open Full Size ↗
                </a>
                <a href={billPreviewUrl} download className="btn-outline hover-text" style={{ padding: "6px 14px", textDecoration: "none", fontSize: 13 }}>
                  ⬇ Download
                </a>
                <button className="btn-outline hover-text" type="button" onClick={() => setBillPreviewUrl(null)} style={{ padding: "6px 14px" }}>
                  ✕ Close
                </button>
              </div>
            </div>
            <img
              src={billPreviewUrl}
              alt="Bill receipt"
              style={{ width: "100%", maxHeight: "70vh", objectFit: "contain", borderRadius: 8, background: "var(--gray-100)" }}
            />
          </div>
        </div>
      )}

      {editOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 520, maxHeight: "80vh", overflowY: "auto" }}>
            <h3>Edit Event — Vendors, Artists & Team</h3>

            <label className="auth-label">Vendors</label>
            <div className="checkbox-list">
              {allVendors.map((v) => (
                <label key={v.id} className="checkbox-option">
                  <input type="checkbox" checked={editVendorIds.includes(v.id)}
                    onChange={(e) => setEditVendorIds(e.target.checked ? [...editVendorIds, v.id] : editVendorIds.filter((x) => x !== v.id))} />
                  {v.companyName}
                </label>
              ))}
              {allVendors.length === 0 && <span className="muted">No vendors available</span>}
            </div>

            <label className="auth-label">Artists</label>
            <div className="checkbox-list">
              {allArtists.map((a) => (
                <label key={a.id} className="checkbox-option">
                  <input type="checkbox" checked={editArtistIds.includes(a.id)}
                    onChange={(e) => setEditArtistIds(e.target.checked ? [...editArtistIds, a.id] : editArtistIds.filter((x) => x !== a.id))} />
                  {a.name}
                </label>
              ))}
              {allArtists.length === 0 && <span className="muted">No artists available</span>}
            </div>

            <label className="auth-label">Team Members</label>
            <div className="checkbox-list">
              {allTeam.map((t) => (
                <label key={t.id} className="checkbox-option">
                  <input type="checkbox" checked={editTeamIds.includes(t.id)}
                    onChange={(e) => setEditTeamIds(e.target.checked ? [...editTeamIds, t.id] : editTeamIds.filter((x) => x !== t.id))} />
                  {t.name} ({t.designation})
                </label>
              ))}
              {allTeam.length === 0 && <span className="muted">No team members available</span>}
            </div>

            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setEditOpen(false)}>Cancel</button>
              <button className="btn-primary" type="button" onClick={saveEdit} disabled={editSaving}>
                {editSaving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 420 }}>
            <h3>Delete Event</h3>
            <p>Are you sure you want to delete <strong>{ev.eventName}</strong>? This will remove all associated vendors, artists, team members, uploads, and expense claims. This action cannot be undone.</p>
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setDeleteConfirm(false)}>Cancel</button>
              <button className="btn-primary" type="button" onClick={handleDelete} style={{ background: "var(--red)" }}>Delete Event</button>
            </div>
          </div>
        </div>
      )}

      {/* Finance Edit Modal */}
      {financeEditId && (
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
