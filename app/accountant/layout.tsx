import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import AppShell from "../components/AppShell";
import { getSessionUser } from "../../lib/session";
import type { NavGroup } from "../../lib/navigation";

type AccountantLayoutProps = {
  children: ReactNode;
};

const ACCOUNTANT_NAV: NavGroup[] = [
  {
    label: "Operations",
    links: [
      { label: "Dashboard", href: "/accountant", minLevel: 3, icon: "dashboard" },
      { label: "Events", href: "/accountant/events", minLevel: 3, icon: "events" },
      { label: "Vendor Management", href: "/accountant/vendor-management", minLevel: 3, icon: "vendors" }
    ]
  },
  {
    label: "Finance",
    links: [
      { label: "Expense Management", href: "/accountant/claim-management", minLevel: 3, icon: "expenses" },
      { label: "Finance", href: "/accountant/finance", minLevel: 3, icon: "finance" }
    ]
  }
];

export default async function AccountantLayout({ children }: AccountantLayoutProps) {
  const cookieStore = await cookies();
  const session = cookieStore.get("velocity_session");
  if (!session) {
    redirect("/login");
  }
  const user = await getSessionUser(
    new Request("http://localhost", {
      headers: { cookie: cookieStore.toString() }
    })
  );
  if (!user) {
    redirect("/login");
  }
  if (user?.role === "Photographer") {
    redirect("/tpp-login/upload");
  }
  if (user.role !== "Accountant") {
    redirect("/");
  }

  return <AppShell groups={ACCOUNTANT_NAV}>{children}</AppShell>;
}
