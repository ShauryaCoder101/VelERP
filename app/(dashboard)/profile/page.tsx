"use client";

import { useEffect, useRef, useState } from "react";

type UserProfile = {
  id: string;
  uid: string;
  name: string;
  email: string;
  designation: string;
  role: string;
  team: string | null;
  avatarUrl: string | null;
  status: string;
  createdAt: string;
};

const roleLevelMap: Record<string, number> = {
  MANAGING_DIRECTOR: 1,
  HEAD_OF_OPERATIONS: 2,
  HEAD_OF_SPECIAL_PROJECTS: 2,
  GROWTH_PARTNER: 2,
  OPERATIONS_TEAM_MEMBER: 3,
  RESEARCH_AND_DEVELOPMENT_TEAM_MEMBER: 3,
  ACCOUNTANT: 3,
  PHOTOGRAPHER: 4,
  INTERN: 4,
  ASSISTANT: 4,
  FREELANCER: 4
};

const roleLabel = (r: string) => r.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const fmt = (iso: string) => {
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }); }
  catch { return iso; }
};

export default function ProfilePage() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadUser = () => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d))
      .catch(() => {});
  };

  useEffect(() => { loadUser(); }, []);

  const handleAvatarUpload = async (file: File) => {
    if (!user) return;
    setUploading(true);
    try {
      const presignRes = await fetch("/api/uploads/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, fileType: file.type, eventId: "avatars" })
      });
      if (!presignRes.ok) { setUploading(false); return; }
      const { uploadUrl, fileUrl } = await presignRes.json();

      await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });

      await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarUrl: fileUrl })
      });
      loadUser();
    } catch { /* ignore */ }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleRemoveAvatar = async () => {
    setUploading(true);
    await fetch("/api/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatarUrl: null })
    });
    loadUser();
    setUploading(false);
  };

  if (!user) return <p style={{ padding: 32 }}>Loading...</p>;

  const level = roleLevelMap[user.role] ?? 4;

  return (
    <>
      <section className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div className="profile-avatar-wrap">
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt={user.name} className="profile-avatar-img" />
            ) : (
              <div className="avatar" style={{ width: 72, height: 72, fontSize: 28 }}>{user.name.charAt(0)}</div>
            )}
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && handleAvatarUpload(e.target.files[0])} />
            <button
              className="profile-avatar-edit"
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              title="Change photo"
            >
              {uploading ? "…" : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              )}
            </button>
          </div>
          <div>
            <h1>{user.name}</h1>
            <p>{user.designation}</p>
          </div>
        </div>
      </section>

      <div className="event-detail-grid">
        <section className="panel">
          <div className="panel-header"><h2>Account Details</h2></div>
          <div className="panel-body">
            <dl className="detail-dl">
              <div><dt>Full Name</dt><dd>{user.name}</dd></div>
              <div><dt>Email</dt><dd>{user.email}</dd></div>
              <div><dt>Employee ID</dt><dd>{user.uid}</dd></div>
              <div><dt>Designation</dt><dd>{user.designation}</dd></div>
              <div><dt>Team</dt><dd>{user.team ?? "—"}</dd></div>
              <div>
                <dt>Status</dt>
                <dd><span className={`status-pill ${user.status === "ACTIVE" ? "active" : "inactive"}`}>{user.status === "ACTIVE" ? "Active" : "Inactive"}</span></dd>
              </div>
            </dl>
            {user.avatarUrl && (
              <button className="btn-outline hover-text" type="button" onClick={handleRemoveAvatar}
                style={{ marginTop: 16, padding: "6px 14px", color: "var(--red)", fontSize: 13 }}>
                Remove Profile Photo
              </button>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header"><h2>Access & Role</h2></div>
          <div className="panel-body">
            <dl className="detail-dl">
              <div><dt>Role</dt><dd>{roleLabel(user.role)}</dd></div>
              <div><dt>Access Level</dt><dd>Level {level}</dd></div>
              <div><dt>Member Since</dt><dd>{fmt(user.createdAt)}</dd></div>
            </dl>
          </div>
        </section>
      </div>
    </>
  );
}
