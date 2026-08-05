"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import SidebarIcon from "./SidebarIcon";
import TopbarActions from "./TopbarActions";
import type { NavGroup } from "../../lib/navigation";

type AppShellProps = {
  groups: NavGroup[];
  children: ReactNode;
};

const menuIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);

export default function AppShell({ groups, children }: AppShellProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Navigating is the same gesture as dismissing the drawer.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  /* The topbar states where you are. A second copy of the logo did not. */
  const pageTitle = useMemo(() => {
    const links = groups.flatMap((g) => g.links);
    const exact = links.find((l) => l.href === pathname);
    if (exact) return exact.label;
    const nested = links
      .filter((l) => l.href !== "/" && pathname.startsWith(`${l.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0];
    return nested?.label ?? "Velocity ERP";
  }, [groups, pathname]);

  return (
    <div className="dashboard">
      <aside className={`sidebar${drawerOpen ? " open" : ""}`}>
        <div className="sidebar-logo">
          <Link href="/" aria-label="Velocity ERP home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="wordmark"
              src="/velocity-wordmark.png"
              alt="Velocity"
              width={640}
              height={148}
              decoding="async"
            />
          </Link>
        </div>

        <nav className="sidebar-nav">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.links.map((link) => {
                const isActive =
                  link.href === "/" ? pathname === "/" : pathname === link.href || pathname.startsWith(`${link.href}/`);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`nav-item${isActive ? " active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <SidebarIcon name={link.icon} />
                    <span>{link.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          Velocity Brand Server Pvt. Ltd.
          <br />
          Brand engagement &amp; event services
        </div>
      </aside>

      <div
        className={`scrim${drawerOpen ? " open" : ""}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      <div className="main">
        <header className="topbar">
          <button
            className="drawer-toggle"
            type="button"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            {menuIcon}
          </button>
          <span className="topbar-title">{pageTitle}</span>
          <TopbarActions />
        </header>

        <main className="content">{children}</main>

        <footer className="footer">
          <span className="footer-brand">Velocity Brand Server Pvt. Ltd.</span>
          <span className="footer-contact">
            <a href="mailto:contact@velocityindia.net" className="hover-text">contact@velocityindia.net</a>
            <a href="tel:+919319713708" className="hover-text">+91 93197 13708</a>
          </span>
          <span className="footer-copy">© 2026 All rights reserved</span>
        </footer>
      </div>
    </div>
  );
}
