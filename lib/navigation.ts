export type NavLink = {
  label: string;
  href: string;
  minLevel: number;
  icon: string;
};

export const NAV_LINKS: NavLink[] = [
  { label: "My Dashboard", href: "/", minLevel: 4, icon: "dashboard" },
  { label: "Events", href: "/events", minLevel: 3, icon: "events" },
  { label: "Vendor Management", href: "/vendor-management", minLevel: 3, icon: "vendors" },
  { label: "Artist Onboarding", href: "/artist-onboarding", minLevel: 3, icon: "artists" },
  { label: "Business Development", href: "/business-development", minLevel: 3, icon: "bd" },
  { label: "Expense Claims", href: "/expense-claims", minLevel: 3, icon: "expenses" },
  { label: "Event Uploads", href: "/event-uploads", minLevel: 3, icon: "uploads" },
  { label: "Team", href: "/team", minLevel: 2, icon: "team" },
  { label: "Admin Panel", href: "/admin", minLevel: 1, icon: "admin" }
];
