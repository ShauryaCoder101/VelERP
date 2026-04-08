"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type EventCard = {
  id: string;
  companyName: string;
  eventName: string;
  pocName: string;
  phase: string;
  fromDate: string;
  toDate: string;
  vendorCount: number;
  teamCount: number;
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

const fmt = (iso: string) => {
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
  catch { return iso; }
};

const SkeletonCards = () => (
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

export default function AccountantEventsPage() {
  const router = useRouter();
  const [events, setEvents] = useState<EventCard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch("/api/events")
      .then((r) => r.json())
      .then((evData) => {
        setEvents(evData.map((e: any) => ({
          id: e.id,
          companyName: e.companyName,
          eventName: e.eventName,
          pocName: e.pocName,
          phase: e.phase,
          fromDate: e.fromDate,
          toDate: e.toDate,
          vendorCount: (e.vendors ?? []).length,
          teamCount: (e.teamMembers ?? []).length
        })));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const grouped = useMemo(() => {
    const map: Record<string, EventCard[]> = {};
    for (const p of PHASE_ORDER) map[p] = [];
    for (const ev of events) {
      const key = ev.phase.toUpperCase();
      if (map[key]) map[key].push(ev);
    }
    return map;
  }, [events]);

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Events</h1>
          <p>View events and manage vendor finances.</p>
        </div>
      </section>

      {loading ? (
        <>
          <SkeletonCards />
          <SkeletonCards />
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
                      onClick={() => router.push(`/accountant/events/${ev.id}`)}
                    >
                      <div className="event-card-top">
                        <span className="event-card-phase" style={{ background: `${color}18`, color }}>{PHASE_LABELS[ev.phase.toUpperCase()] ?? ev.phase}</span>
                        <span className="event-card-dates">{fmt(ev.fromDate)} – {fmt(ev.toDate)}</span>
                      </div>
                      <h3 className="event-card-title">{ev.eventName}</h3>
                      <p className="event-card-company">{ev.companyName}</p>
                      <div className="event-card-meta">
                        <span>POC: {ev.pocName}</span>
                        {ev.vendorCount > 0 && <span>{ev.vendorCount} vendor{ev.vendorCount > 1 ? "s" : ""}</span>}
                        {ev.teamCount > 0 && <span>{ev.teamCount} team</span>}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}

          {events.length === 0 && (
            <section className="panel">
              <div className="empty-state">No events found.</div>
            </section>
          )}
        </>
      )}
    </>
  );
}
