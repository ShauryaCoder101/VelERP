"use client";

import { useEffect, useRef, useState, useCallback } from "react";

type SessionUser = { name: string; email: string };

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
  actor: { id: string; name: string };
};

const typeIcon: Record<string, string> = {
  vendor: "🏢",
  artist: "🎤",
  bd_call: "📞",
  event_added: "🎉",
  event_closed: "✅"
};

const timeAgo = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
};

export default function TopbarActions() {
  const [profileOpen, setProfileOpen] = useState(false);
  const [notiOpen, setNotiOpen] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const notiRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.ok ? r.json() : null).then((u) => u && setUser(u)).catch(() => {});
  }, []);

  const loadNotifications = useCallback(() => {
    fetch("/api/notifications").then((r) => r.ok ? r.json() : []).then(setNotifications).catch(() => {});
  }, []);

  useEffect(() => {
    loadNotifications();
    const interval = setInterval(loadNotifications, 30000);
    return () => clearInterval(interval);
  }, [loadNotifications]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setProfileOpen(false);
      if (!notiRef.current?.contains(e.target as Node)) setNotiOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  const markAllRead = async () => {
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markAllRead: true })
    });
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const markRead = async (id: string) => {
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read: true } : n));
  };

  const initials = user?.name
    ? user.name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()
    : "U";

  return (
    <div className="topbar-actions">
      {/* Notifications */}
      <div className="noti-wrap" ref={notiRef}>
        <button
          className="icon-button hover-text"
          type="button"
          aria-label="Notifications"
          onClick={() => setNotiOpen((p) => !p)}
        >
          <span className="bell" />
          {unreadCount > 0 && <span className="noti-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}
        </button>
        {notiOpen && (
          <div className="noti-panel">
            <div className="noti-panel-header">
              <strong>Notifications</strong>
              {unreadCount > 0 && (
                <button className="noti-mark-all" type="button" onClick={markAllRead}>Mark all read</button>
              )}
            </div>
            <div className="noti-list">
              {notifications.length === 0 ? (
                <div className="noti-empty">No notifications yet.</div>
              ) : (
                notifications.map((n) => (
                  <button
                    key={n.id}
                    className={`noti-item ${n.read ? "" : "noti-unread"}`}
                    type="button"
                    onClick={() => markRead(n.id)}
                  >
                    <span className="noti-icon">{typeIcon[n.type] ?? "🔔"}</span>
                    <div className="noti-content">
                      <span className="noti-body">{n.body}</span>
                      <span className="noti-time">{timeAgo(n.createdAt)}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Profile */}
      <div ref={menuRef}>
        <button className="profile-button hover-text" type="button" onClick={() => setProfileOpen((p) => !p)}>
          <span className="avatar">{initials}</span>
          <span className="profile-name">{user?.name ?? "User"}</span>
          <span className="chevron" aria-hidden="true" />
        </button>
        {profileOpen && (
          <div className="profile-menu">
            <div className="profile-meta">
              <strong>{user?.name ?? "User"}</strong>
              <span>{user?.email ?? ""}</span>
            </div>
            <a className="profile-link hover-text" href="/profile">My Profile</a>
            <button className="profile-link danger" type="button" onClick={handleLogout}>Logout</button>
          </div>
        )}
      </div>
    </div>
  );
}
