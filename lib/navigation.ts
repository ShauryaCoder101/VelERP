export type NavLink = {
  label: string;
  href: string;
  minLevel: number;
  icon: string;
};

export type NavGroup = {
  label: string;
  links: NavLink[];
};

/* Grouped by what the work actually is, not by permission level.
   Ten flat destinations are hard to scan; three named domains are not. */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Operations",
    links: [
      { label: "My Dashboard", href: "/", minLevel: 4, icon: "dashboard" },
      { label: "Events", href: "/events", minLevel: 3, icon: "events" },
      { label: "Vendor Management", href: "/vendor-management", minLevel: 3, icon: "vendors" },
      { label: "Artist Onboarding", href: "/artist-onboarding", minLevel: 3, icon: "artists" },
      { label: "Event Uploads", href: "/event-uploads", minLevel: 3, icon: "uploads" },
      { label: "Research", href: "/research", minLevel: 4, icon: "research" }
    ]
  },
  {
    label: "Commercial",
    links: [
      { label: "Sales", href: "/sales", minLevel: 3, icon: "sales" },
      { label: "Business Development", href: "/business-development", minLevel: 3, icon: "bd" },
      { label: "Expense Claims", href: "/expense-claims", minLevel: 3, icon: "expenses" }
    ]
  },
  {
    label: "Administration",
    links: [
      { label: "Team", href: "/team", minLevel: 2, icon: "team" },
      { label: "Admin Panel", href: "/admin", minLevel: 1, icon: "admin" }
    ]
  }
];

/* Flat list kept for any caller that just needs every destination. */
export const NAV_LINKS: NavLink[] = NAV_GROUPS.flatMap((group) => group.links);
