"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type UpcomingDeal = {
  id: string;
  dealName: string;
  amount: number;
  stage: string;
  expectedCloseDate: string;
  assignedToUser: { name: string } | null;
};

const stageLabel: Record<string, string> = {
  QUALIFICATION: "Qualification", NEEDS_ANALYSIS: "Needs Analysis",
  VALUE_PROPOSITION: "Value Proposition", IDENTIFY_DECISION_MAKERS: "Decision Makers",
  PROPOSAL_PRICE_QUOTE: "Proposal/Quote", NEGOTIATION_REVIEW: "Negotiation"
};

// Monochrome ramp — darker means further along. Red is reserved for the
// stage that needs someone today.
const stageColor: Record<string, string> = {
  QUALIFICATION: "#9a9aa3", NEEDS_ANALYSIS: "#82828c", VALUE_PROPOSITION: "#5c5c66",
  IDENTIFY_DECISION_MAKERS: "#42424a", PROPOSAL_PRICE_QUOTE: "#2a2a30",
  NEGOTIATION_REVIEW: "#ed3039"
};

type DashboardStats = {
  totalEvents: number;
  activeVendors: number;
  pendingClaims: number;
  teamMembers: number;
};

const iconProps = {
  width: 18, height: 18, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const
};

const statsCardsMeta = [
  {
    key: "totalEvents" as const, title: "Events",
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    )
  },
  {
    key: "activeVendors" as const, title: "Active vendors",
    icon: (
      <svg {...iconProps}>
        <path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 21v-6h6v6" />
      </svg>
    )
  },
  {
    key: "pendingClaims" as const, title: "Pending claims",
    icon: (
      <svg {...iconProps}>
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="15" y2="17" />
      </svg>
    )
  },
  {
    key: "teamMembers" as const, title: "Team members",
    icon: (
      <svg {...iconProps}>
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" />
      </svg>
    )
  }
];

// Each action goes to the screen that performs it — no dead buttons.
const quickActions = [
  {
    label: "Open events", href: "/events",
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <line x1="3" y1="10" x2="21" y2="10" /><line x1="12" y1="14" x2="12" y2="18" />
        <line x1="10" y1="16" x2="14" y2="16" />
      </svg>
    )
  },
  {
    label: "Add a vendor", href: "/vendor-management",
    icon: (
      <svg {...iconProps}>
        <path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 21v-6h6v6" />
      </svg>
    )
  },
  {
    label: "File a claim", href: "/expense-claims",
    icon: (
      <svg {...iconProps}>
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" />
        <polyline points="14 2 14 8 20 8" /><line x1="12" y1="12" x2="12" y2="18" />
        <line x1="9" y1="15" x2="15" y2="15" />
      </svg>
    )
  },
  {
    label: "Upload event files", href: "/event-uploads",
    icon: (
      <svg {...iconProps}>
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
      </svg>
    )
  }
];

const fmt = (iso: string) => {
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return iso; }
};

const daysUntil = (iso: string) => {
  const diff = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return `${diff} days`;
};

export default function DashboardPage() {
  const [upcoming, setUpcoming] = useState<UpcomingDeal[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/sales/upcoming").then(r => r.json()).catch(() => []),
      fetch("/api/stats").then(r => r.json()).catch(() => null)
    ]).then(([dealsData, statsData]) => {
      setUpcoming(Array.isArray(dealsData) ? dealsData : []);
      setStats(statsData);
      setLoading(false);
    });
  }, []);

  const pipelineValue = upcoming.reduce((sum, d) => sum + (d.amount || 0), 0);

  return (
    <>
      {/* The frame paints immediately; only the figures wait on the network. */}
      <section className="page-header">
        <h1>My Dashboard</h1>
        <p>Events, vendors, claims and the deals closing next.</p>
      </section>

      <section className="stats-grid">
        {statsCardsMeta.map((card) => (
          <div key={card.key} className="stat-card">
            <span className="stat-icon" aria-hidden="true">{card.icon}</span>
            <div className="stat-content">
              {loading
                ? <div className="skeleton skeleton-stat-value" />
                : <div className="stat-value">{stats ? stats[card.key] : "—"}</div>}
              <div className="stat-label">{card.title}</div>
            </div>
          </div>
        ))}
      </section>

      <section className="grid-two">
        <div className="panel">
          <div className="panel-header claims-header">
            <div>
              <h2>Deals closing soon</h2>
              {!loading && upcoming.length > 0 && (
                <p className="muted">
                  {upcoming.length} deal{upcoming.length !== 1 ? "s" : ""} · ₹{pipelineValue.toLocaleString("en-IN")}
                </p>
              )}
            </div>
            <Link href="/sales" className="hover-text muted">View pipeline →</Link>
          </div>
          <div className="panel-body">
            {loading ? (
              <>
                {[1, 2, 3].map((i) => (
                  <div key={i} className="skeleton-table-row">
                    <span className="skeleton skeleton-cell skeleton-cell-wide" />
                    <span className="skeleton skeleton-cell skeleton-cell-medium" />
                    <span className="skeleton skeleton-cell skeleton-cell-medium" />
                    <span className="skeleton skeleton-cell skeleton-cell-medium" />
                  </div>
                ))}
              </>
            ) : upcoming.length === 0 ? (
              <div className="empty-state">
                No deals have a close date set. Add one from the pipeline to see it here.
              </div>
            ) : (
              <div className="table-wrap">
                <table className="claims-table">
                  <thead>
                    <tr><th>Deal</th><th>Amount</th><th>Stage</th><th>Closing</th><th>Owner</th></tr>
                  </thead>
                  <tbody>
                    {upcoming.map(d => (
                      <tr key={d.id}>
                        <td>
                          <Link href={`/sales/deals/${d.id}`} className="hover-text">
                            <strong>{d.dealName}</strong>
                          </Link>
                        </td>
                        <td className="amount-cell">₹{d.amount.toLocaleString("en-IN")}</td>
                        <td>
                          <span
                            className="phase-pill"
                            style={{ background: `${stageColor[d.stage] || "#82828c"}14`, color: stageColor[d.stage] || "#82828c" }}
                          >
                            {stageLabel[d.stage] || d.stage}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontSize: 13 }}>{daysUntil(d.expectedCloseDate)}</span>
                          <span className="cell-meta" style={{ display: "block" }}>{fmt(d.expectedCloseDate)}</span>
                        </td>
                        <td>{d.assignedToUser?.name || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Jump to</h2>
          </div>
          <div className="panel-body">
            <div className="actions-grid">
              {quickActions.map((action) => (
                <Link key={action.href} href={action.href} className="action-card">
                  <span className="action-icon" aria-hidden="true">{action.icon}</span>
                  <span>{action.label}</span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
