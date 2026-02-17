export type NavLink = {
  label: string;
  href: string;
  minLevel: number;
};

export const NAV_LINKS: NavLink[] = [
  { label: "My Dashboard", href: "/", minLevel: 4 },
  { label: "Events", href: "/events", minLevel: 3 },
  { label: "Vendor Management", href: "/vendor-management", minLevel: 3 },
  { label: "Artist Onboarding", href: "/artist-onboarding", minLevel: 3 },
  { label: "Expense Claims", href: "/expense-claims", minLevel: 3 },
  { label: "Event Uploads", href: "/event-uploads", minLevel: 3 },
  { label: "Team", href: "/team", minLevel: 2 }
];
