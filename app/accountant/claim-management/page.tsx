"use client";

import { useEffect, useMemo, useState } from "react";

type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: string;
};

type ClaimItem = {
  id: string;
  eventName: string;
  amount: number;
};

type ExpenseClaim = {
  id: string;
  userId: string;
  status: "INCOMPLETE" | "FLAGGED" | "DONE";
  submittedAt: string;
  items: ClaimItem[];
};

const STATUS_OPTIONS: ExpenseClaim["status"][] = ["INCOMPLETE", "FLAGGED", "DONE"];

export default function AccountantClaimManagementPage() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [claims, setClaims] = useState<ExpenseClaim[]>([]);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);

  useEffect(() => {
    const loadData = async () => {
      const [teamRes, claimsRes] = await Promise.all([fetch("/api/team"), fetch("/api/expense-claims")]);
      if (teamRes.ok) {
        const data = await teamRes.json();
        setMembers(
          data
            .filter((member: any) => member.role !== "ACCOUNTANT")
            .map((member: any) => ({
              id: member.id,
              name: member.name,
              email: member.email,
              role: member.role
            }))
        );
      }
      if (claimsRes.ok) {
        const data = await claimsRes.json();
        setClaims(
          data.map((claim: any) => ({
            id: claim.id,
            userId: claim.userId,
            status: claim.status,
            submittedAt: claim.submittedAt,
            items: (claim.items ?? []).map((item: any) => ({
              id: item.id,
              eventName: item.eventName,
              amount: item.amount
            }))
          }))
        );
      }
    };
    loadData();
  }, []);

  const claimsByUser = useMemo(() => {
    const map = new Map<string, ExpenseClaim[]>();
    claims.forEach((claim) => {
      const list = map.get(claim.userId) ?? [];
      list.push(claim);
      map.set(claim.userId, list);
    });
    return map;
  }, [claims]);

  const handleStatusChange = async (claimId: string, status: ExpenseClaim["status"]) => {
    const response = await fetch(`/api/expense-claims/${claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    if (!response.ok) return;
    setClaims((prev) => prev.map((claim) => (claim.id === claimId ? { ...claim, status } : claim)));
  };

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Expense Management</h1>
          <p>Review and update expense claims by team member.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Team Claims</h2>
        </div>
        <div className="panel-body">
          <div className="claims-list">
            {members.map((member) => {
              const memberClaims = claimsByUser.get(member.id) ?? [];
              const isOpen = activeUserId === member.id;
              return (
                <div key={member.id} className="claims-group">
                  <button
                    className="claims-toggle"
                    type="button"
                    onClick={() => setActiveUserId(isOpen ? null : member.id)}
                  >
                    <div>
                      <strong>{member.name}</strong>
                      <div className="muted">{member.email}</div>
                    </div>
                    <span className="muted">{memberClaims.length} claims</span>
                  </button>
                  {isOpen ? (
                    <div className="claims-table-wrap">
                      {memberClaims.length === 0 ? (
                        <div className="empty-state">No claims filed.</div>
                      ) : (
                        <table className="uploads-table">
                          <thead>
                            <tr>
                              <th>Claim ID</th>
                              <th>Submitted</th>
                              <th>Events</th>
                              <th>Total Amount</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {memberClaims.map((claim) => {
                              const total = claim.items.reduce((sum, item) => sum + item.amount, 0);
                              return (
                                <tr key={claim.id}>
                                  <td>{claim.id.slice(0, 8).toUpperCase()}</td>
                                  <td>{new Date(claim.submittedAt).toLocaleDateString()}</td>
                                  <td>{claim.items.map((item) => item.eventName).join(", ") || "—"}</td>
                                  <td>{total.toFixed(2)}</td>
                                  <td>
                                    <select
                                      className="input select"
                                      value={claim.status}
                                      onChange={(event) =>
                                        handleStatusChange(claim.id, event.target.value as ExpenseClaim["status"])
                                      }
                                    >
                                      {STATUS_OPTIONS.map((status) => (
                                        <option key={status} value={status}>
                                          {status}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </>
  );
}
