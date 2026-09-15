"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCurrentUser } from "./useCurrentUser";

/* The Research module's own navigation.

   Everything here used to hang off one muted line of links at the bottom of the
   search page, which nobody found. This bar sits under the masthead on every
   research screen instead, so the five other rooms are always one click away.

   Admin is the exception: it is the Managing Director's screen, so the tab is
   only rendered at role level 1 and the route itself refuses everyone else.
   Until the lookup answers, the tab is hidden — an admin briefly missing a tab
   is a smaller sin than everyone else seeing one they cannot use. */

type Tab = {
  href: string;
  label: string;
  /** Lowest role level allowed to see this tab (1 = Managing Director). */
  minLevel?: number;
};

const TABS: Tab[] = [
  { href: "/research", label: "Search" },
  { href: "/research/browse", label: "Browse" },
  { href: "/research/clip", label: "Clip" },
  { href: "/research/log", label: "Research log" },
  { href: "/research/sources", label: "Sources" },
  { href: "/research/admin", label: "Admin", minLevel: 1 }
];

/** Search owns only its exact path; every other tab owns its subtree.

    /research/ideas/... deliberately matches nothing: an idea is reached from
    Search, Browse or a research job alike, so lighting up any one of them would
    be a guess about where the reader came from. */
const isActive = (pathname: string, href: string): boolean => {
  if (href === "/research") return pathname === "/research";
  return pathname === href || pathname.startsWith(`${href}/`);
};

export default function ResearchNav() {
  const pathname = usePathname() ?? "";
  const { user } = useCurrentUser();
  const level = user?.level ?? 99;

  const tabs = TABS.filter((tab) => tab.minLevel === undefined || level <= tab.minLevel);

  return (
    <nav className="rs-tabs" aria-label="Research">
      {tabs.map((tab) => {
        const active = isActive(pathname, tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`rs-tab${active ? " active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
