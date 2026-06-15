"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ReactNode } from "react";

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

const svgBase = {
  width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const
};

const bellIcon = (
  <svg {...svgBase}>
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const typeIcon: Record<string, ReactNode> = {
  vendor: (
    <svg {...svgBase}>
      <path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 21v-6h6v6" />
    </svg>
  ),
  artist: (
    <svg {...svgBase}>
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" /><line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  ),
  bd_call: (
    <svg {...svgBase}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  ),
  event_added: (
    <svg {...svgBase}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="12" y1="13" x2="12" y2="18" /><line x1="9.5" y1="15.5" x2="14.5" y2="15.5" />
    </svg>
  ),
  event_closed: (
    <svg {...svgBase}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  )
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
          {bellIcon}
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
                    <span className="noti-icon">{typeIcon[n.type] ?? bellIcon}</span>
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
