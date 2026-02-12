"use client";

import { useMemo, useState } from "react";
import { currentUser } from "../../../lib/auth";

type RatingEntry = {
  rating: number;
  remarks: string;
  by: string;
  date: string;
};

type Vendor = {
  id: number;
  companyName: string;
  phone: string;
  work: string;
  gstin: string;
  status: "Active" | "Inactive";
  currentEvent: string;
  onboardedAt: string;
  onboardedBy: string;
  ratings: RatingEntry[];
};

const createVendor = (id: number): Vendor => ({
  id,
  companyName: "",
  phone: "",
  work: "",
  gstin: "",
  status: "Inactive",
  currentEvent: "",
  onboardedAt: new Date().toLocaleString(),
  onboardedBy: currentUser.name,
  ratings: []
});

export default function VendorManagementPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [ratingVendorId, setRatingVendorId] = useState<number | null>(null);
  const [historyVendorId, setHistoryVendorId] = useState<number | null>(null);
  const [ratingValue, setRatingValue] = useState("5");
  const [ratingRemarks, setRatingRemarks] = useState("");
  const [deleteVendorId, setDeleteVendorId] = useState<number | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newVendor, setNewVendor] = useState<Vendor>(createVendor(1));

  const handleVendorChange = (id: number, field: keyof Vendor, value: string) => {
    setVendors((prev) => prev.map((vendor) => (vendor.id === id ? { ...vendor, [field]: value } : vendor)));
  };

  const handleAddVendor = () => {
    setIsAddOpen(true);
    setNewVendor(createVendor(vendors.length + 1));
  };

  const handleRemoveVendor = (id: number) => {
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

  const handleSubmitRating = () => {
    if (!ratingTarget) return;
    const entry: RatingEntry = {
      rating: Number(ratingValue),
      remarks: ratingRemarks.trim(),
      by: currentUser.name,
      date: new Date().toLocaleString()
    };

    setVendors((prev) =>
      prev.map((vendor) =>
        vendor.id === ratingTarget.id ? { ...vendor, ratings: [entry, ...vendor.ratings] } : vendor
      )
    );
    setRatingVendorId(null);
    setRatingRemarks("");
    setRatingValue("5");
  };

  const handleCreateVendor = () => {
    const nextId = vendors.length === 0 ? 1 : Math.max(...vendors.map((vendor) => vendor.id)) + 1;
    setVendors((prev) => [
      ...prev,
      {
        ...newVendor,
        id: nextId,
        onboardedAt: new Date().toLocaleString(),
        onboardedBy: currentUser.name
      }
    ]);
    setIsAddOpen(false);
  };

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
            <p className="muted">Onboarded by: {currentUser.name}</p>
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
                  <th>Ph No</th>
                  <th>Work</th>
                  <th>GSTIN</th>
                  <th>Status</th>
                  <th>Rating</th>
                  <th>History</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {vendors.length === 0 ? (
                  <tr>
                    <td colSpan={9}>
                      <div className="empty-state">No onboarded vendors yet.</div>
                    </td>
                  </tr>
                ) : (
                  vendors.map((vendor, index) => (
                    <tr key={vendor.id}>
                      <td>{index + 1}</td>
                      <td>{vendor.companyName || "—"}</td>
                      <td>{vendor.phone || "—"}</td>
                      <td>{vendor.work || "—"}</td>
                      <td>{vendor.gstin || "—"}</td>
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
          <div className="modal-card">
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
    </>
  );
}
