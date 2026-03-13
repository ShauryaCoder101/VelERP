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
const stageColor: Record<string, string> = {
  QUALIFICATION: "#3b82f6", NEEDS_ANALYSIS: "#6366f1", VALUE_PROPOSITION: "#8b5cf6",
  IDENTIFY_DECISION_MAKERS: "#a855f7", PROPOSAL_PRICE_QUOTE: "#d946ef",
  NEGOTIATION_REVIEW: "#e89b0c"
};

const statsCards = [
  { title: "Total Events" },
  { title: "Active Vendors" },
  { title: "Pending Claims" },
  { title: "Team Members" }
];

const quickActions = ["Create Event", "Add Vendor", "File Claim", "Upload Files"];

const fmt = (iso: string) => {
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return iso; }
};

const daysUntil = (iso: string) => {
  const diff = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return `${diff} days`;
};

export default function DashboardPage() {
  const [upcoming, setUpcoming] = useState<UpcomingDeal[]>([]);

  useEffect(() => {
    fetch("/api/sales/upcoming").then(r => r.json()).then(setUpcoming).catch(() => {});
  }, []);

  return (
    <>
      <section className="page-header">
        <div>
          <h1>My Dashboard</h1>
          <p>Welcome back. Here&apos;s your overview.</p>
        </div>
      </section>

      <section className="stats-grid">
        {statsCards.map((card) => (
          <div key={card.title} className="stat-card">
            <div className="stat-icon" aria-hidden="true" />
            <div className="stat-content">
              <div className="stat-value">—</div>
              <div className="stat-label">{card.title}</div>
            </div>
            <div className="stat-trend">—</div>
          </div>
        ))}
      </section>

      <section className="grid-two">
        {/* Upcoming Deals */}
        <div className="panel">
          <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2>Upcoming Deals</h2>
            <Link href="/sales" className="hover-text" style={{ fontSize: 13 }}>View all →</Link>
          </div>
          <div className="panel-body">
            {upcoming.length === 0 ? (
              <p style={{ color: "var(--gray-400)", textAlign: "center", padding: "20px 0" }}>No upcoming deals with close dates.</p>
            ) : (
              <div className="table-wrap">
                <table className="claims-table">
                  <thead>
                    <tr><th>Deal</th><th>Amount</th><th>Stage</th><th>Closing In</th><th>Owner</th></tr>
                  </thead>
                  <tbody>
                    {upcoming.map(d => (
                      <tr key={d.id}>
                        <td>
                          <Link href={`/sales/deals/${d.id}`} className="hover-text">
                            <strong>{d.dealName}</strong>
                          </Link>
                        </td>
                        <td style={{ fontWeight: 600 }}>₹{d.amount.toLocaleString("en-IN")}</td>
                        <td>
                          <span className="phase-pill" style={{ background: `${stageColor[d.stage] || "#6b7280"}18`, color: stageColor[d.stage] || "#6b7280" }}>
                            {stageLabel[d.stage] || d.stage}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontSize: 13 }}>{daysUntil(d.expectedCloseDate)}</span>
                          <br />
                          <span style={{ fontSize: 11, color: "var(--gray-400)" }}>{fmt(d.expectedCloseDate)}</span>
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

        {/* Quick Actions */}
        <div className="panel">
          <div className="panel-header">
            <h2>Quick Actions</h2>
          </div>
          <div className="panel-body">
            <div className="actions-grid">
              {quickActions.map((action) => (
                <button key={action} className="action-card hover-text" type="button">
                  <span className="action-icon" aria-hidden="true" />
                  <span>{action}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
