"use client";

import { useEffect, useMemo, useState } from "react";

type RatingEntry = {
  id?: string;
  rating: number;
  remarks: string;
  by: string;
  date: string;
};

type Vendor = {
  id: string;
  companyName: string;
  email: string;
  location: string;
  phone: string;
  work: string;
  gstin: string;
  panCard: string;
  pocName: string;
  status: "Active" | "Inactive";
  currentEvent: string;
  onboardedAt: string;
  onboardedBy: string;
  onboardedById: string;
  ratings: RatingEntry[];
};

type SessionUser = { id: string; name: string; role: string };

const createVendor = (userName: string): Vendor => ({
  id: "",
  companyName: "",
  email: "",
  location: "",
  phone: "",
  work: "",
  gstin: "",
  panCard: "",
  pocName: "",
  status: "Inactive",
  currentEvent: "",
  onboardedAt: new Date().toLocaleString(),
  onboardedBy: userName,
  onboardedById: "",
  ratings: []
});

export default function VendorManagementPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [ratingVendorId, setRatingVendorId] = useState<string | null>(null);
  const [historyVendorId, setHistoryVendorId] = useState<string | null>(null);
  const [ratingValue, setRatingValue] = useState("5");
  const [ratingRemarks, setRatingRemarks] = useState("");
  const [deleteVendorId, setDeleteVendorId] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newVendor, setNewVendor] = useState<Vendor>(createVendor(""));
  const [editVendorId, setEditVendorId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Vendor | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  // Fetch session user
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => u && setSessionUser({ id: u.id, name: u.name, role: u.role }))
      .catch(() => {});
  }, []);

  // Fetch vendors
  useEffect(() => {
    const loadVendors = async () => {
      setLoading(true);
      const response = await fetch("/api/vendors");
      if (!response.ok) { setLoading(false); return; }
      const data = await response.json();
      const mapped = data.map((vendor: any) => ({
        id: vendor.id,
        companyName: vendor.companyName,
        email: vendor.email ?? "",
        location: vendor.location ?? "",
        phone: vendor.phone,
        work: vendor.work,
        gstin: vendor.gstin ?? "",
        panCard: vendor.panCard ?? "",
        pocName: vendor.pocName ?? "",
        status: vendor.status === "ACTIVE" ? "Active" : "Inactive",
        currentEvent: vendor.currentEvent ?? "",
        onboardedAt: new Date(vendor.onboardedAt).toLocaleString(),
        onboardedBy: vendor.onboardedByUser?.name ?? vendor.onboardedBy,
        onboardedById: vendor.onboardedByUser?.id ?? vendor.onboardedBy,
        ratings: (vendor.ratings ?? []).map((rating: any) => ({
          id: rating.id,
          rating: rating.rating,
          remarks: rating.remarks ?? "",
          by: rating.userId,
          date: new Date(rating.createdAt).toLocaleString()
        }))
      }));
      setVendors(mapped);
      setLoading(false);
    };
    loadVendors();
  }, []);

  const handleAddVendor = () => {
    setIsAddOpen(true);
    setNewVendor(createVendor(sessionUser?.name ?? ""));
  };

  const handleRemoveVendor = async (id: string) => {
    const response = await fetch(`/api/vendors/${id}`, { method: "DELETE" });
    if (!response.ok) return;
    setVendors((prev) => prev.filter((vendor) => vendor.id !== id));
  };

  const ratingTarget = useMemo(
    () => vendors.find((vendor) => vendor.id === ratingVendorId) ?? null,
    [ratingVendorId, vendors]
  );

  const historyTarget = useMemo(
    () => vendors.find((vendor) => vendor.id === historyVendorId) ?? null,
    [historyVendorId, vendors]
  );

  const deleteTarget = useMemo(
    () => vendors.find((vendor) => vendor.id === deleteVendorId) ?? null,
    [deleteVendorId, vendors]
  );

  const getAverageRating = (ratings: RatingEntry[]) => {
    if (ratings.length === 0) return "—";
    const total = ratings.reduce((sum, entry) => sum + entry.rating, 0);
    return (total / ratings.length).toFixed(1);
  };

  const canEditVendor = (vendor: Vendor) => {
    if (!sessionUser) return false;
    if (sessionUser.role === "Managing Director") return true;
    return vendor.onboardedById === sessionUser.id;
  };

  const handleSubmitRating = async () => {
    if (!ratingTarget) return;
    const response = await fetch(`/api/vendors/${ratingTarget.id}/ratings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: ratingValue, remarks: ratingRemarks })
    });
    if (!response.ok) return;
    const entry = await response.json();
    setVendors((prev) =>
      prev.map((vendor) =>
        vendor.id === ratingTarget.id
          ? {
              ...vendor,
              ratings: [
                {
                  id: entry.id,
                  rating: entry.rating,
                  remarks: entry.remarks ?? "",
                  by: sessionUser?.name ?? "",
                  date: new Date(entry.createdAt).toLocaleString()
                },
                ...vendor.ratings
              ]
            }
          : vendor
      )
    );
    setRatingVendorId(null);
    setRatingRemarks("");
    setRatingValue("5");
  };

  useEffect(() => {
    const loadHistory = async () => {
      if (!historyTarget) return;
      const response = await fetch(`/api/vendors/${historyTarget.id}/ratings`);
      if (!response.ok) return;
      const data = await response.json();
      setVendors((prev) =>
        prev.map((vendor) =>
          vendor.id === historyTarget.id
            ? {
                ...vendor,
                ratings: data.map((entry: any) => ({
                  id: entry.id,
                  rating: entry.rating,
                  remarks: entry.remarks ?? "",
                  by: entry.user?.name ?? entry.userId,
                  date: new Date(entry.createdAt).toLocaleString()
                }))
              }
            : vendor
        )
      );
    };
    loadHistory();
  }, [historyTarget]);

  const handleCreateVendor = async () => {
    const response = await fetch("/api/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyName: newVendor.companyName,
        email: newVendor.email,
        location: newVendor.location,
        phone: newVendor.phone,
        work: newVendor.work,
        gstin: newVendor.gstin,
        panCard: newVendor.panCard,
        pocName: newVendor.pocName,
        status: newVendor.status === "Active" ? "ACTIVE" : "INACTIVE",
        currentEvent: newVendor.currentEvent
      })
    });
    if (!response.ok) return;
    const created = await response.json();
    setVendors((prev) => [
      {
        id: created.id,
        companyName: created.companyName,
        email: created.email ?? "",
        location: created.location ?? "",
        phone: created.phone,
        work: created.work,
        gstin: created.gstin ?? "",
        panCard: created.panCard ?? "",
        pocName: created.pocName ?? "",
        status: created.status === "ACTIVE" ? "Active" : "Inactive",
        currentEvent: created.currentEvent ?? "",
        onboardedAt: new Date(created.onboardedAt).toLocaleString(),
        onboardedBy: sessionUser?.name ?? "",
        onboardedById: sessionUser?.id ?? "",
        ratings: []
      },
      ...prev
    ]);
    setIsAddOpen(false);
  };

  const openEditVendor = (vendor: Vendor) => {
    setEditVendorId(vendor.id);
    setEditForm({ ...vendor });
  };

  const handleSaveEdit = async () => {
    if (!editForm || !editVendorId) return;
    setEditSaving(true);
    const response = await fetch(`/api/vendors/${editVendorId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyName: editForm.companyName,
        email: editForm.email,
        phone: editForm.phone,
        work: editForm.work,
        location: editForm.location,
        gstin: editForm.gstin,
        panCard: editForm.panCard,
        pocName: editForm.pocName,
        status: editForm.status === "Active" ? "ACTIVE" : "INACTIVE",
        currentEvent: editForm.currentEvent
      })
    });
    setEditSaving(false);
    if (!response.ok) {
      const msg = await response.text();
      alert(msg || "Failed to update vendor");
      return;
    }
    const updated = await response.json();
    setVendors((prev) =>
      prev.map((v) =>
        v.id === editVendorId
          ? {
              ...v,
              companyName: updated.companyName,
              email: updated.email ?? "",
              phone: updated.phone,
              work: updated.work,
              location: updated.location ?? "",
              gstin: updated.gstin ?? "",
              panCard: updated.panCard ?? "",
              pocName: updated.pocName ?? "",
              status: updated.status === "ACTIVE" ? "Active" : "Inactive",
              currentEvent: updated.currentEvent ?? ""
            }
          : v
      )
    );
    setEditVendorId(null);
    setEditForm(null);
  };

  // Skeleton rows for loading state
  const SkeletonTableRows = () => (
    <>
      {[1, 2, 3, 4, 5].map((i) => (
        <tr key={i}>
          {Array.from({ length: 13 }).map((_, j) => (
            <td key={j}>
              <div className="skeleton skeleton-cell" style={{ width: j === 0 ? 25 : j < 3 ? 120 : 80, height: 14 }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Vendor Management</h1>
          <p>Track onboarding, work status, and vendor ratings.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header claims-header">
          <div>
            <h2>Vendors</h2>
            {sessionUser && <p className="muted">Logged in as: {sessionUser.name}</p>}
          </div>
          <div className="claims-actions">
            <button className="btn-outline hover-text" type="button" onClick={handleAddVendor}>
              Add Vendor
            </button>
          </div>
        </div>
        <div className="panel-body">
          <div className="table-wrap">
            <table className="vendor-table">
              <thead>
                <tr>
                  <th>S.No</th>
                  <th>Company Name</th>
                  <th>POC Name</th>
                  <th>Email</th>
                  <th>Location</th>
                  <th>Ph No</th>
                  <th>Work</th>
                  <th>GSTIN</th>
                  <th>PAN Card</th>
                  <th>Status</th>
                  <th>Rating</th>
                  <th>History</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <SkeletonTableRows />
                ) : vendors.length === 0 ? (
                  <tr>
                    <td colSpan={13}>
                      <div className="empty-state">No onboarded vendors yet.</div>
                    </td>
                  </tr>
                ) : (
                  vendors.map((vendor, index) => (
                    <tr key={vendor.id}>
                      <td>{index + 1}</td>
                      <td>{vendor.companyName || "—"}</td>
                      <td>{vendor.pocName || "—"}</td>
                      <td>{vendor.email || "—"}</td>
                      <td>{vendor.location || "—"}</td>
                      <td>{vendor.phone || "—"}</td>
                      <td>{vendor.work || "—"}</td>
                      <td>{vendor.gstin || "—"}</td>
                      <td>{vendor.panCard || "—"}</td>
                      <td>
                        <span className={`status-pill ${vendor.status === "Active" ? "active" : "inactive"}`}>
                          {vendor.status}
                        </span>
                        {vendor.status === "Active" && vendor.currentEvent ? (
                          <div className="cell-meta">Event: {vendor.currentEvent}</div>
                        ) : null}
                        <div className="cell-meta">
                          Onboarded {vendor.onboardedAt} by {vendor.onboardedBy}
                        </div>
                      </td>
                      <td>
                        <button
                          className="rating-button hover-text"
                          type="button"
                          onClick={() => setRatingVendorId(vendor.id)}
                        >
                          {getAverageRating(vendor.ratings)}
                        </button>
                      </td>
                      <td>
                        <button
                          className="link-button hover-text"
                          type="button"
                          onClick={() => setHistoryVendorId(vendor.id)}
                        >
                          View
                        </button>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          {canEditVendor(vendor) && (
                            <button
                              className="edit-btn"
                              type="button"
                              onClick={() => openEditVendor(vendor)}
                            >
                              ✎ Edit
                            </button>
                          )}
                          <button
                            className="row-remove"
                            type="button"
                            aria-label="Delete vendor"
                            onClick={() => {
                              setDeleteVendorId(vendor.id);
                              setDeleteConfirmText("");
                            }}
                          >
                            ×
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {ratingTarget ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Rate Vendor</h3>
            <p className="muted">{ratingTarget.companyName || "Vendor"}</p>
            <label className="auth-label" htmlFor="rating">
              Rating (out of 5)
            </label>
            <select
              id="rating"
              className="input select"
              value={ratingValue}
              onChange={(event) => setRatingValue(event.target.value)}
            >
              {["5", "4", "3", "2", "1"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <label className="auth-label" htmlFor="remarks">
              Remarks
            </label>
            <textarea
              id="remarks"
              className="input textarea"
              rows={3}
              value={ratingRemarks}
              onChange={(event) => setRatingRemarks(event.target.value)}
              placeholder="Add remarks"
            />
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setRatingVendorId(null)}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={handleSubmitRating}>
                Save Rating
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {historyTarget ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Rating History</h3>
            <p className="muted">{historyTarget.companyName || "Vendor"}</p>
            <div className="history-list">
              {historyTarget.ratings.length === 0 ? (
                <p className="muted">No ratings yet.</p>
              ) : (
                historyTarget.ratings.map((entry, index) => (
                  <div key={`${entry.by}-${entry.date}-${index}`} className="history-item">
                    <div>
                      <strong>{entry.rating}/5</strong> by {entry.by}
                    </div>
                    <div className="muted">{entry.date}</div>
                    {entry.remarks ? <div>{entry.remarks}</div> : null}
                  </div>
                ))
              )}
            </div>
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setHistoryVendorId(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Delete Vendor</h3>
            <p className="muted">
              Are you sure you want to delete{" "}
              <strong>{deleteTarget.companyName || "this vendor"}</strong>?
            </p>
            <label className="auth-label" htmlFor="delete-confirm">
              Type DELETE to confirm
            </label>
            <input
              id="delete-confirm"
              className="input"
              value={deleteConfirmText}
              onChange={(event) => setDeleteConfirmText(event.target.value)}
              placeholder="DELETE"
            />
            <div className="modal-actions">
              <button
                className="btn-outline hover-text"
                type="button"
                onClick={() => setDeleteVendorId(null)}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                type="button"
                disabled={deleteConfirmText !== "DELETE"}
                onClick={() => {
                  if (!deleteTarget || deleteConfirmText !== "DELETE") return;
                  handleRemoveVendor(deleteTarget.id);
                  setDeleteVendorId(null);
                  setDeleteConfirmText("");
                }}
              >
                Delete Vendor
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isAddOpen ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxHeight: "90vh", overflowY: "auto" }}>
            <h3>Add Vendor</h3>
            <label className="auth-label" htmlFor="vendor-company">
              Company Name
            </label>
            <input
              id="vendor-company"
              className="input"
              value={newVendor.companyName}
              onChange={(event) => setNewVendor((prev) => ({ ...prev, companyName: event.target.value }))}
              placeholder="Company"
            />
            <label className="auth-label" htmlFor="vendor-poc">
              POC Name
            </label>
            <input
              id="vendor-poc"
              className="input"
              value={newVendor.pocName}
              onChange={(event) => setNewVendor((prev) => ({ ...prev, pocName: event.target.value }))}
              placeholder="Point of Contact"
            />
            <label className="auth-label" htmlFor="vendor-email">
              Email
            </label>
            <input
              id="vendor-email"
              className="input"
              type="email"
              value={newVendor.email}
              onChange={(event) => setNewVendor((prev) => ({ ...prev, email: event.target.value }))}
              placeholder="vendor@example.com"
            />
            <label className="auth-label" htmlFor="vendor-phone">
              Phone
            </label>
            <input
              id="vendor-phone"
              className="input"
              value={newVendor.phone}
              onChange={(event) => setNewVendor((prev) => ({ ...prev, phone: event.target.value }))}
              placeholder="Phone"
            />
            <label className="auth-label" htmlFor="vendor-location">
              Location
            </label>
            <input
              id="vendor-location"
              className="input"
              value={newVendor.location}
              onChange={(event) => setNewVendor((prev) => ({ ...prev, location: event.target.value }))}
              placeholder="Location"
            />
            <label className="auth-label" htmlFor="vendor-work">
              Work
            </label>
            <input
              id="vendor-work"
              className="input"
              value={newVendor.work}
              onChange={(event) => setNewVendor((prev) => ({ ...prev, work: event.target.value }))}
              placeholder="Work Type"
            />
            <label className="auth-label" htmlFor="vendor-gstin">
              GSTIN
            </label>
            <input
              id="vendor-gstin"
              className="input"
              value={newVendor.gstin}
              onChange={(event) => setNewVendor((prev) => ({ ...prev, gstin: event.target.value }))}
              placeholder="GSTIN"
            />
            <label className="auth-label" htmlFor="vendor-pan">
              PAN Card
            </label>
            <input
              id="vendor-pan"
              className="input"
              value={newVendor.panCard}
              onChange={(event) => setNewVendor((prev) => ({ ...prev, panCard: event.target.value }))}
              placeholder="PAN Card Number"
            />
            <label className="auth-label" htmlFor="vendor-status">
              Status
            </label>
            <select
              id="vendor-status"
              className="input select"
              value={newVendor.status}
              onChange={(event) =>
                setNewVendor((prev) => ({ ...prev, status: event.target.value as Vendor["status"] }))
              }
            >
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
            {newVendor.status === "Active" ? (
              <>
                <label className="auth-label" htmlFor="vendor-event">
                  Current Event
                </label>
                <input
                  id="vendor-event"
                  className="input"
                  value={newVendor.currentEvent}
                  onChange={(event) => setNewVendor((prev) => ({ ...prev, currentEvent: event.target.value }))}
                  placeholder="Event name"
                />
              </>
            ) : null}
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setIsAddOpen(false)}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={handleCreateVendor}>
                Save Vendor
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editForm && editVendorId ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxHeight: "90vh", overflowY: "auto" }}>
            <h3>Edit Vendor</h3>
            <p className="muted">Editing: {editForm.companyName}</p>
            <label className="auth-label" htmlFor="edit-company">Company Name</label>
            <input id="edit-company" className="input" value={editForm.companyName}
              onChange={(e) => setEditForm((p) => p && ({ ...p, companyName: e.target.value }))} />
            <label className="auth-label" htmlFor="edit-poc">POC Name</label>
            <input id="edit-poc" className="input" value={editForm.pocName}
              onChange={(e) => setEditForm((p) => p && ({ ...p, pocName: e.target.value }))}
              placeholder="Point of Contact" />
            <label className="auth-label" htmlFor="edit-email">Email</label>
            <input id="edit-email" className="input" type="email" value={editForm.email}
              onChange={(e) => setEditForm((p) => p && ({ ...p, email: e.target.value }))} />
            <label className="auth-label" htmlFor="edit-phone">Phone</label>
            <input id="edit-phone" className="input" value={editForm.phone}
              onChange={(e) => setEditForm((p) => p && ({ ...p, phone: e.target.value }))} />
            <label className="auth-label" htmlFor="edit-location">Location</label>
            <input id="edit-location" className="input" value={editForm.location}
              onChange={(e) => setEditForm((p) => p && ({ ...p, location: e.target.value }))} />
            <label className="auth-label" htmlFor="edit-work">Work</label>
            <input id="edit-work" className="input" value={editForm.work}
              onChange={(e) => setEditForm((p) => p && ({ ...p, work: e.target.value }))} />
            <label className="auth-label" htmlFor="edit-gstin">GSTIN</label>
            <input id="edit-gstin" className="input" value={editForm.gstin}
              onChange={(e) => setEditForm((p) => p && ({ ...p, gstin: e.target.value }))} />
            <label className="auth-label" htmlFor="edit-pan">PAN Card</label>
            <input id="edit-pan" className="input" value={editForm.panCard}
              onChange={(e) => setEditForm((p) => p && ({ ...p, panCard: e.target.value }))}
              placeholder="PAN Card Number" />
            <label className="auth-label" htmlFor="edit-status">Status</label>
            <select id="edit-status" className="input select" value={editForm.status}
              onChange={(e) => setEditForm((p) => p && ({ ...p, status: e.target.value as Vendor["status"] }))}>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
            {editForm.status === "Active" ? (
              <>
                <label className="auth-label" htmlFor="edit-event">Current Event</label>
                <input id="edit-event" className="input" value={editForm.currentEvent}
                  onChange={(e) => setEditForm((p) => p && ({ ...p, currentEvent: e.target.value }))}
                  placeholder="Event name" />
              </>
            ) : null}
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => { setEditVendorId(null); setEditForm(null); }}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={handleSaveEdit} disabled={editSaving}>
                {editSaving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
