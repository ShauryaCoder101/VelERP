"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import SidebarIcon from "./SidebarIcon";

const LINKS = [
  { label: "Dashboard", href: "/accountant", icon: "dashboard" },
  { label: "Events", href: "/accountant/events", icon: "events" },
  { label: "Expense Management", href: "/accountant/claim-management", icon: "expenses" },
  { label: "Vendor Management", href: "/accountant/vendor-management", icon: "vendors" },
  { label: "Finance", href: "/accountant/finance", icon: "finance" }
];

export default function AccountantSidebar() {
  const pathname = usePathname();

  return (
    <nav className="sidebar-nav">
      {LINKS.map((link) => {
        const isActive = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`nav-item hover-text${isActive ? " active" : ""}`}
          >
            <SidebarIcon name={link.icon} />
            <span>{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
