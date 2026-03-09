"use client";

import { useEffect, useState } from "react";
import { normalizeRole } from "../../../lib/rbac";

const ALL_ROLES = [
  "MANAGING_DIRECTOR", "HEAD_OF_OPERATIONS", "HEAD_OF_SPECIAL_PROJECTS",
  "GROWTH_PARTNER", "OPERATIONS_TEAM_MEMBER", "RESEARCH_AND_DEVELOPMENT_TEAM_MEMBER",
  "ACCOUNTANT", "PHOTOGRAPHER", "INTERN", "ASSISTANT", "FREELANCER"
];

const roleLabel = (r: string) => normalizeRole(r);

type User = {
  id: string;
  uid: string;
  name: string;
  email: string;
  designation: string;
  role: string;
  team: string | null;
  status: string;
};

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ uid: "", name: "", email: "", designation: "", role: "INTERN", team: "", password: "" });

  const [pwOpen, setPwOpen] = useState<User | null>(null);
  const [newPw, setNewPw] = useState("");

  const [editOpen, setEditOpen] = useState<User | null>(null);
  const [editForm, setEditForm] = useState({ name: "", email: "", designation: "", role: "", team: "", status: "" });

  const [deleteConfirm, setDeleteConfirm] = useState<User | null>(null);

  const load = () => {
    fetch("/api/team").then((r) => r.json()).then((d) => setUsers(d)).catch(() => {});
    fetch("/api/auth/me").then((r) => r.json()).then((d) => setCurrentUserId(d.id)).catch(() => {});
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async () => {
    const res = await fetch("/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(addForm)
    });
    if (res.ok) {
      setAddOpen(false);
      setAddForm({ uid: "", name: "", email: "", designation: "", role: "INTERN", team: "", password: "" });
      load();
    }
  };

  const handleChangePw = async () => {
    if (!pwOpen || !newPw) return;
    await fetch(`/api/admin/users/${pwOpen.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: newPw })
    });
    setPwOpen(null);
    setNewPw("");
  };

  const handleEdit = async () => {
    if (!editOpen) return;
    await fetch(`/api/admin/users/${editOpen.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editForm)
    });
    setEditOpen(null);
    load();
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    await fetch(`/api/admin/users/${deleteConfirm.id}`, { method: "DELETE" });
    setDeleteConfirm(null);
    load();
  };

  const openEdit = (u: User) => {
    setEditOpen(u);
    setEditForm({ name: u.name, email: u.email, designation: u.designation, role: u.role, team: u.team ?? "", status: u.status });
  };

  return (
    <>
      <section className="page-header">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1>Admin Panel</h1>
            <p>Manage users, roles, and passwords.</p>
          </div>
          <button className="btn-primary" type="button" onClick={() => setAddOpen(true)}>+ Add User</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><h2>All Users ({users.length})</h2></div>
        <div className="panel-body">
          <div className="table-wrap">
            <table className="team-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>UID</th>
                  <th>Designation</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td><strong>{u.name}</strong></td>
                    <td>{u.email}</td>
                    <td className="muted">{u.uid}</td>
                    <td>{u.designation}</td>
                    <td><span className="phase-pill">{roleLabel(u.role)}</span></td>
                    <td><span className={`status-pill ${u.status === "ACTIVE" ? "active" : "inactive"}`}>{u.status === "ACTIVE" ? "Active" : "Inactive"}</span></td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="btn-outline hover-text" type="button" onClick={() => openEdit(u)} style={{ padding: "4px 10px", fontSize: 12 }}>Edit</button>
                        <button className="btn-outline hover-text" type="button" onClick={() => { setPwOpen(u); setNewPw(""); }} style={{ padding: "4px 10px", fontSize: 12 }}>Reset PW</button>
                        {u.id !== currentUserId && (
                          <button className="btn-outline hover-text" type="button" onClick={() => setDeleteConfirm(u)} style={{ padding: "4px 10px", fontSize: 12, color: "var(--red)" }}>Delete</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Add User Modal */}
      {addOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 480, maxHeight: "90vh", overflowY: "auto" }}>
            <h3>Add New User</h3>
            <label className="auth-label">Employee ID (UID)</label>
            <input className="input" value={addForm.uid} onChange={(e) => setAddForm((p) => ({ ...p, uid: e.target.value }))} placeholder="e.g. OPS-007" />
            <label className="auth-label">Full Name</label>
            <input className="input" value={addForm.name} onChange={(e) => setAddForm((p) => ({ ...p, name: e.target.value }))} placeholder="John Doe" />
            <label className="auth-label">Email</label>
            <input className="input" type="email" value={addForm.email} onChange={(e) => setAddForm((p) => ({ ...p, email: e.target.value }))} placeholder="john@velocityindia.net" />
            <label className="auth-label">Designation</label>
            <input className="input" value={addForm.designation} onChange={(e) => setAddForm((p) => ({ ...p, designation: e.target.value }))} placeholder="Operations Team Member" />
            <label className="auth-label">Role</label>
            <select className="input select" value={addForm.role} onChange={(e) => setAddForm((p) => ({ ...p, role: e.target.value }))}>
              {ALL_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
            <label className="auth-label">Team (optional)</label>
            <input className="input" value={addForm.team} onChange={(e) => setAddForm((p) => ({ ...p, team: e.target.value }))} placeholder="Operations" />
            <label className="auth-label">Password</label>
            <input className="input" type="text" value={addForm.password} onChange={(e) => setAddForm((p) => ({ ...p, password: e.target.value }))} placeholder="Leave blank for ChangeMe123!" />
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setAddOpen(false)}>Cancel</button>
              <button className="btn-primary" type="button" onClick={handleAdd} disabled={!addForm.uid || !addForm.name || !addForm.email}>Create User</button>
            </div>
          </div>
        </div>
      )}

      {/* Change Password Modal */}
      {pwOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Reset Password</h3>
            <p className="muted">Changing password for <strong>{pwOpen.name}</strong> ({pwOpen.email})</p>
            <label className="auth-label">New Password</label>
            <input className="input" type="text" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="Enter new password" />
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setPwOpen(null)}>Cancel</button>
              <button className="btn-primary" type="button" onClick={handleChangePw} disabled={!newPw}>Save Password</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 480, maxHeight: "90vh", overflowY: "auto" }}>
            <h3>Edit User</h3>
            <label className="auth-label">Full Name</label>
            <input className="input" value={editForm.name} onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))} />
            <label className="auth-label">Email</label>
            <input className="input" type="email" value={editForm.email} onChange={(e) => setEditForm((p) => ({ ...p, email: e.target.value }))} />
            <label className="auth-label">Designation</label>
            <input className="input" value={editForm.designation} onChange={(e) => setEditForm((p) => ({ ...p, designation: e.target.value }))} />
            <label className="auth-label">Role</label>
            <select className="input select" value={editForm.role} onChange={(e) => setEditForm((p) => ({ ...p, role: e.target.value }))}>
              {ALL_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
            <label className="auth-label">Team</label>
            <input className="input" value={editForm.team} onChange={(e) => setEditForm((p) => ({ ...p, team: e.target.value }))} />
            <label className="auth-label">Status</label>
            <select className="input select" value={editForm.status} onChange={(e) => setEditForm((p) => ({ ...p, status: e.target.value }))}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setEditOpen(null)}>Cancel</button>
              <button className="btn-primary" type="button" onClick={handleEdit}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Delete User</h3>
            <p>Are you sure you want to permanently delete <strong>{deleteConfirm.name}</strong> ({deleteConfirm.email})?</p>
            <p className="muted">This will remove all their sessions and cannot be undone.</p>
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className="btn-primary" type="button" onClick={handleDelete} style={{ background: "var(--red)" }}>Delete User</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
