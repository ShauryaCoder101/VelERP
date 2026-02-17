import Link from "next/link";

const LINKS = [
  { label: "Dashboard", href: "/accountant" },
  { label: "Expense Management", href: "/accountant/claim-management" },
  { label: "Vendor Management", href: "/accountant/vendor-management" },
  { label: "Event Bills", href: "/accountant/event-bills" },
  { label: "Finance", href: "/accountant/finance" }
];

export default function AccountantSidebar() {
  return (
    <nav className="sidebar-nav">
      {LINKS.map((link) => (
        <Link key={link.href} href={link.href} className="nav-item hover-text">
          <span className="nav-icon" aria-hidden="true" />
          <span>{link.label}</span>
        </Link>
      ))}
    </nav>
  );
}
