"use client";

import { useEffect, useRef, useState } from "react";

type SessionUser = {
  name: string;
  email: string;
};

export default function TopbarActions() {
  const [isOpen, setIsOpen] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadUser = async () => {
      const response = await fetch("/api/auth/me");
      if (!response.ok) return;
      setUser(await response.json());
    };
    loadUser();
  }, []);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "U";

  return (
    <div className="topbar-actions" ref={menuRef}>
      <button className="icon-button hover-text" type="button" aria-label="Notifications">
        <span className="bell" />
        <span className="status-dot" />
      </button>
      <button className="profile-button hover-text" type="button" onClick={() => setIsOpen((prev) => !prev)}>
        <span className="avatar">{initials}</span>
        <span className="profile-name">{user?.name ?? "User"}</span>
        <span className="chevron" aria-hidden="true" />
      </button>
      {isOpen ? (
        <div className="profile-menu">
          <div className="profile-meta">
            <strong>{user?.name ?? "User"}</strong>
            <span>{user?.email ?? ""}</span>
          </div>
          <a className="profile-link hover-text" href="/profile">
            My Profile
          </a>
          <button className="profile-link danger" type="button" onClick={handleLogout}>
            Logout
          </button>
        </div>
      ) : null}
    </div>
  );
}
