"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: string;
};

type ClaimItem = {
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

type ExpenseClaim = {
  id: string;
  userId: string;
  status: "ACTIVE" | "INACTIVE";
  submittedAt: string;
  items: ClaimItem[];
  attachments: ClaimAttachment[];
};

const STATUS_OPTIONS: { value: ExpenseClaim["status"]; label: string }[] = [
  { value: "INACTIVE", label: "Pending" },
  { value: "ACTIVE", label: "Approved" },
];

export default function AccountantClaimManagementPage() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [claims, setClaims] = useState<ExpenseClaim[]>([]);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const openSignedUrl = useCallback(async (rawUrl: string, mode: "preview" | "tab") => {
    try {
      setLoadingPreview(true);
      const res = await fetch(`/api/uploads/view?url=${encodeURIComponent(rawUrl)}`);
      if (!res.ok) throw new Error("Failed to get signed URL");
      const { signedUrl } = await res.json();
      if (mode === "preview") {
        setPreviewUrl(signedUrl);
      } else {
        window.open(signedUrl, "_blank");
      }
    } catch (err) {
      console.error(err);
      alert("Could not load the file. Please try again.");
    } finally {
      setLoadingPreview(false);
    }
  }, []);

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
              location: item.location ?? "",
              type: item.type ?? "",
              date: item.date,
              amount: item.amount
            })),
            attachments: (claim.attachments ?? []).map((att: any) => ({
              id: att.id,
              fileUrl: att.fileUrl,
              fileType: att.fileType
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

  const isImage = (fileType: string) => fileType.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(fileType);

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
              const totalAmount = memberClaims.reduce((sum, c) => sum + c.items.reduce((s, i) => s + i.amount, 0), 0);
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
                    <span className="muted">
                      {memberClaims.length} claim{memberClaims.length !== 1 ? "s" : ""}
                      {totalAmount > 0 ? ` · ₹${totalAmount.toLocaleString("en-IN")}` : ""}
                    </span>
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
                              <th>Event</th>
                              <th>Type</th>
                              <th>Location</th>
                              <th>Amount</th>
                              <th>Bill / Receipt</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {memberClaims.map((claim) => {
                              const total = claim.items.reduce((sum, item) => sum + item.amount, 0);
                              const hasAttachments = claim.attachments.length > 0;
                              return (
                                <tr key={claim.id}>
                                  <td>{claim.id.slice(0, 8).toUpperCase()}</td>
                                  <td>{new Date(claim.submittedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</td>
                                  <td>{claim.items.map((item) => item.eventName).join(", ") || "—"}</td>
                                  <td className="muted">{claim.items.map((item) => item.type).filter(Boolean).join(", ") || "—"}</td>
                                  <td className="muted">{claim.items.map((item) => item.location).filter(Boolean).join(", ") || "—"}</td>
                                  <td style={{ fontWeight: 600 }}>₹{total.toLocaleString("en-IN")}</td>
                                  <td>
                                    {hasAttachments ? (
                                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                        {claim.attachments.map((att) => (
                                          isImage(att.fileType) ? (
                                            <button
                                              key={att.id}
                                              type="button"
                                              className="finance-edit-btn"
                                              disabled={loadingPreview}
                                              onClick={() => openSignedUrl(att.fileUrl, "preview")}
                                              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                                            >
                                              {loadingPreview ? "⏳" : "🖼"} View
                                            </button>
                                          ) : (
                                            <button
                                              key={att.id}
                                              type="button"
                                              className="finance-edit-btn"
                                              disabled={loadingPreview}
                                              onClick={() => openSignedUrl(att.fileUrl, "tab")}
                                              style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer" }}
                                            >
                                              {loadingPreview ? "⏳" : "📄"} View PDF
                                            </button>
                                          )
                                        ))}
                                      </div>
                                    ) : (
                                      <span className="muted">—</span>
                                    )}
                                  </td>
                                  <td>
                                    <select
                                      className="input select"
                                      value={claim.status}
                                      onChange={(event) =>
                                        handleStatusChange(claim.id, event.target.value as ExpenseClaim["status"])
                                      }
                                    >
                                      {STATUS_OPTIONS.map((opt) => (
                                        <option key={opt.value} value={opt.value}>
                                          {opt.label}
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

      {/* Image Preview Modal */}
      {previewUrl && (
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={() => setPreviewUrl(null)}>
          <div className="modal-card" style={{ maxWidth: 720, padding: 16 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>Bill / Receipt</h3>
              <div style={{ display: "flex", gap: 8 }}>
                <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="btn-outline hover-text" style={{ padding: "6px 14px", textDecoration: "none", fontSize: 13 }}>
                  Open Full Size ↗
                </a>
                <a href={previewUrl} download className="btn-outline hover-text" style={{ padding: "6px 14px", textDecoration: "none", fontSize: 13 }}>
                  ⬇ Download
                </a>
                <button className="btn-outline hover-text" type="button" onClick={() => setPreviewUrl(null)} style={{ padding: "6px 14px" }}>
                  ✕ Close
                </button>
              </div>
            </div>
            <img
              src={previewUrl}
              alt="Bill receipt"
              style={{ width: "100%", maxHeight: "70vh", objectFit: "contain", borderRadius: 8, background: "var(--gray-100)" }}
            />
          </div>
        </div>
      )}
    </>
  );
}
