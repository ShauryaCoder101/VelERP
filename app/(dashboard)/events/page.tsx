"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type VendorSummary = { id: string; companyName: string };
type ArtistSummary = { id: string; name: string };
type TeamSummary = { id: string; name: string; designation: string };

type EventCard = {
  id: string;
  companyName: string;
  eventName: string;
  pocName: string;
  pocPhone: string;
  phase: string;
  fromDate: string;
  toDate: string;
  vendorIds: string[];
  artistIds: string[];
  teamMemberIds: string[];
  vendorNames: string[];
  artistNames: string[];
  teamNames: string[];
};

const PHASE_ORDER = ["ONGOING", "PREPARATION", "BIDDING", "PITCHING", "IDEATION", "FINISHED"] as const;
const PHASE_LABELS: Record<string, string> = {
  ONGOING: "Ongoing", PREPARATION: "Preparation", BIDDING: "Bidding",
  PITCHING: "Pitching", IDEATION: "Ideation", FINISHED: "Finished"
};
const PHASE_COLORS: Record<string, string> = {
  ONGOING: "#16b65f", PREPARATION: "#e89b0c", BIDDING: "#3b82f6",
  PITCHING: "#8b5cf6", IDEATION: "#e1162a", FINISHED: "#6b7280"
};
const ALL_PHASES = ["IDEATION", "PITCHING", "BIDDING", "PREPARATION", "ONGOING", "FINISHED"];

const fmt = (iso: string) => {
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
  catch { return iso; }
};

const SkeletonEventCards = () => (
  <section style={{ marginTop: 8 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
      <div className="skeleton" style={{ width: 12, height: 12, borderRadius: "50%" }} />
      <div className="skeleton" style={{ width: 120, height: 20 }} />
    </div>
    <div className="event-cards-grid">
      {[1, 2, 3].map((i) => (
        <div key={i} className="skeleton-event-card">
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div className="skeleton" style={{ width: 80, height: 22, borderRadius: 999 }} />
            <div className="skeleton" style={{ width: 100, height: 14 }} />
          </div>
          <div className="skeleton" style={{ width: "75%", height: 20 }} />
          <div className="skeleton" style={{ width: "50%", height: 14 }} />
          <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
            <div className="skeleton" style={{ width: 80, height: 13 }} />
            <div className="skeleton" style={{ width: 60, height: 13 }} />
          </div>
        </div>
      ))}
    </div>
  </section>
);

export default function EventsPage() {
  const router = useRouter();
  const [events, setEvents] = useState<EventCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [vendors, setVendors] = useState<VendorSummary[]>([]);
  const [artists, setArtists] = useState<ArtistSummary[]>([]);
  const [team, setTeam] = useState<TeamSummary[]>([]);
  const [addOpen, setAddOpen] = useState(false);

  const [form, setForm] = useState({
    companyName: "", eventName: "", pocName: "", pocPhone: "",
    phase: "IDEATION", fromDate: "", toDate: "",
    vendorIds: [] as string[], artistIds: [] as string[], teamMemberIds: [] as string[]
  });

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch("/api/events").then((r) => r.json()),
      fetch("/api/vendors").then((r) => r.json()),
      fetch("/api/artists").then((r) => r.json()),
      fetch("/api/team").then((r) => r.json())
    ]).then(([evData, vData, aData, tData]) => {
      const vendorMap = new Map(vData.map((v: any) => [v.id, v.companyName]));
      const artistMap = new Map(aData.map((a: any) => [a.id, a.name]));
      const teamMap = new Map(tData.map((t: any) => [t.id, t.name]));

      setVendors(vData.map((v: any) => ({ id: v.id, companyName: v.companyName })));
      setArtists(aData.map((a: any) => ({ id: a.id, name: a.name })));
      setTeam(tData.map((t: any) => ({ id: t.id, name: t.name, designation: t.designation })));
      setEvents(evData.map((e: any) => {
        const vIds = (e.vendors ?? []).map((ev: any) => ev.vendorId ?? ev.vendor?.id);
        const aIds = (e.artists ?? []).map((ea: any) => ea.artistId ?? ea.artist?.id);
        const tIds = (e.teamMembers ?? []).map((et: any) => et.userId ?? et.user?.id);
        return {
          id: e.id,
          companyName: e.companyName,
          eventName: e.eventName,
          pocName: e.pocName,
          pocPhone: e.pocPhone,
          phase: e.phase,
          fromDate: e.fromDate,
          toDate: e.toDate,
          vendorIds: vIds,
          artistIds: aIds,
          teamMemberIds: tIds,
          vendorNames: vIds.map((vid: string) => vendorMap.get(vid) ?? ""),
          artistNames: aIds.map((aid: string) => artistMap.get(aid) ?? ""),
          teamNames: tIds.map((tid: string) => teamMap.get(tid) ?? "")
        };
      }));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const grouped = useMemo(() => {
    const map: Record<string, EventCard[]> = {};
    for (const p of PHASE_ORDER) map[p] = [];
    for (const ev of events) {
      const key = ev.phase.toUpperCase();
      if (map[key]) map[key].push(ev);
      else {
        if (!map[key]) map[key] = [];
        map[key].push(ev);
      }
    }
    return map;
  }, [events]);

  const resetForm = () => {
    setForm({ companyName: "", eventName: "", pocName: "", pocPhone: "", phase: "IDEATION", fromDate: "", toDate: "", vendorIds: [], artistIds: [], teamMemberIds: [] });
  };

  const handleCreate = async () => {
    const res = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });
    if (!res.ok) return;
    const created = await res.json();
    const card: EventCard = {
      id: created.id,
      companyName: created.companyName,
      eventName: created.eventName,
      pocName: created.pocName,
      pocPhone: created.pocPhone,
      phase: created.phase,
      fromDate: created.fromDate,
      toDate: created.toDate,
      vendorIds: form.vendorIds,
      artistIds: form.artistIds,
      teamMemberIds: form.teamMemberIds,
      vendorNames: form.vendorIds.map((vid) => vendors.find((v) => v.id === vid)?.companyName ?? ""),
      artistNames: form.artistIds.map((aid) => artists.find((a) => a.id === aid)?.name ?? ""),
      teamNames: form.teamMemberIds.map((tid) => team.find((t) => t.id === tid)?.name ?? "")
    };
    setEvents((prev) => [card, ...prev]);
    setAddOpen(false);
    resetForm();
  };

  const toggleMulti = (field: "vendorIds" | "artistIds" | "teamMemberIds", id: string) => {
    setForm((prev) => ({
      ...prev,
      [field]: prev[field].includes(id) ? prev[field].filter((x) => x !== id) : [...prev[field], id]
    }));
  };

  return (
    <>
      <section className="page-header">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1>Events</h1>
            <p>All events grouped by phase.</p>
          </div>
          <button className="btn-primary" type="button" onClick={() => { resetForm(); setAddOpen(true); }}>
            + Add Event
          </button>
        </div>
      </section>

      {loading ? (
        <>
          <SkeletonEventCards />
          <SkeletonEventCards />
        </>
      ) : (
        <>
          {PHASE_ORDER.map((phase) => {
            const cards = grouped[phase];
            if (!cards || cards.length === 0) return null;
            const color = PHASE_COLORS[phase] ?? "#e1162a";
            return (
              <section key={phase} className="phase-section">
                <div className="phase-section-header">
                  <span className="phase-section-dot" style={{ background: color }} />
                  <h2>{PHASE_LABELS[phase] ?? phase}</h2>
                  <span className="muted">({cards.length})</span>
                </div>
                <div className="event-cards-grid">
                  {cards.map((ev) => (
                    <button
                      key={ev.id}
                      type="button"
                      className="event-card"
                      onClick={() => router.push(`/events/${ev.id}`)}
                    >
                      <div className="event-card-top">
                        <span className="event-card-phase" style={{ background: `${color}18`, color }}>{PHASE_LABELS[ev.phase.toUpperCase()] ?? ev.phase}</span>
                        <span className="event-card-dates">{fmt(ev.fromDate)} – {fmt(ev.toDate)}</span>
                      </div>
                      <h3 className="event-card-title">{ev.eventName}</h3>
                      <p className="event-card-company">{ev.companyName}</p>
                      <div className="event-card-meta">
                        <span>POC: {ev.pocName}</span>
                        {ev.vendorNames.length > 0 && <span>{ev.vendorNames.length} vendor{ev.vendorNames.length > 1 ? "s" : ""}</span>}
                        {ev.artistNames.length > 0 && <span>{ev.artistNames.length} artist{ev.artistNames.length > 1 ? "s" : ""}</span>}
                        {ev.teamNames.length > 0 && <span>{ev.teamNames.length} team</span>}
                      </div>
                      {ev.teamNames.length > 0 && (
                        <div className="event-card-avatars">
                          {ev.teamNames.slice(0, 4).map((name, i) => (
                            <span key={i} className="avatar" style={{ width: 28, height: 28, fontSize: 11, marginLeft: i > 0 ? -8 : 0 }}>{name.charAt(0)}</span>
                          ))}
                          {ev.teamNames.length > 4 && <span className="muted" style={{ marginLeft: 4 }}>+{ev.teamNames.length - 4}</span>}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}

          {events.length === 0 && (
            <section className="panel">
              <div className="empty-state">No events yet. Click &quot;+ Add Event&quot; to create one.</div>
            </section>
          )}
        </>
      )}

      {addOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 520, maxHeight: "90vh", overflowY: "auto" }}>
            <h3>Add Event</h3>

            <label className="auth-label">Event Name</label>
            <input className="input" value={form.eventName} onChange={(e) => setForm((p) => ({ ...p, eventName: e.target.value }))} placeholder="e.g. Annual Gala 2026" />

            <label className="auth-label">Company Name</label>
            <input className="input" value={form.companyName} onChange={(e) => setForm((p) => ({ ...p, companyName: e.target.value }))} placeholder="Client company" />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label className="auth-label">POC Name</label>
                <input className="input" value={form.pocName} onChange={(e) => setForm((p) => ({ ...p, pocName: e.target.value }))} placeholder="Point of contact" />
              </div>
              <div>
                <label className="auth-label">POC Phone</label>
                <input className="input" value={form.pocPhone} onChange={(e) => setForm((p) => ({ ...p, pocPhone: e.target.value }))} placeholder="+91" />
              </div>
            </div>

            <label className="auth-label">Phase</label>
            <select className="input select" value={form.phase} onChange={(e) => setForm((p) => ({ ...p, phase: e.target.value }))}>
              {ALL_PHASES.map((p) => <option key={p} value={p}>{PHASE_LABELS[p]}</option>)}
            </select>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label className="auth-label">Start Date</label>
                <input className="input" type="date" value={form.fromDate} onChange={(e) => setForm((p) => ({ ...p, fromDate: e.target.value }))} />
              </div>
              <div>
                <label className="auth-label">End Date</label>
                <input className="input" type="date" value={form.toDate} onChange={(e) => setForm((p) => ({ ...p, toDate: e.target.value }))} />
              </div>
            </div>

            <label className="auth-label">Velocity Team Members</label>
            <div className="checkbox-list">
              {team.map((t) => (
                <label key={t.id} className="checkbox-option">
                  <input type="checkbox" checked={form.teamMemberIds.includes(t.id)} onChange={() => toggleMulti("teamMemberIds", t.id)} />
                  <span>{t.name} <span className="muted">({t.designation})</span></span>
                </label>
              ))}
            </div>

            <label className="auth-label">Vendors Involved</label>
            <div className="checkbox-list">
              {vendors.map((v) => (
                <label key={v.id} className="checkbox-option">
                  <input type="checkbox" checked={form.vendorIds.includes(v.id)} onChange={() => toggleMulti("vendorIds", v.id)} />
                  <span>{v.companyName}</span>
                </label>
              ))}
              {vendors.length === 0 && <p className="muted">No vendors in system yet.</p>}
            </div>

            <label className="auth-label">Artists Involved</label>
            <div className="checkbox-list">
              {artists.map((a) => (
                <label key={a.id} className="checkbox-option">
                  <input type="checkbox" checked={form.artistIds.includes(a.id)} onChange={() => toggleMulti("artistIds", a.id)} />
                  <span>{a.name}</span>
                </label>
              ))}
              {artists.length === 0 && <p className="muted">No artists in system yet.</p>}
            </div>

            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setAddOpen(false)}>Cancel</button>
              <button className="btn-primary" type="button" onClick={handleCreate} disabled={!form.eventName || !form.companyName || !form.fromDate || !form.toDate}>
                Save Event
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
