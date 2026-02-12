"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { currentUser } from "../../lib/auth";
import { NAV_LINKS } from "../../lib/navigation";
import { hasAccess } from "../../lib/rbac";

export default function SidebarNav() {
  const pathname = usePathname();
  const visibleLinks = NAV_LINKS.filter((link) => hasAccess(currentUser.role, link.minLevel));

  return (
    <nav className="sidebar-nav">
      {visibleLinks.map((link) => {
        const isActive = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`nav-item hover-text${isActive ? " active" : ""}`}
          >
            <span className="nav-icon" aria-hidden="true" />
            <span>{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
