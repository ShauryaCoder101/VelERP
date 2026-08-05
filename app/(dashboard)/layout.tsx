import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import AppShell from "../components/AppShell";
import { getSessionUser } from "../../lib/session";
import { NAV_GROUPS } from "../../lib/navigation";
import { hasAccess, normalizeRole } from "../../lib/rbac";

type DashboardLayoutProps = {
  children: ReactNode;
};

export default async function DashboardLayout({ children }: DashboardLayoutProps) {
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
  if (user?.role === "Accountant") {
    redirect("/accountant");
  }
  if (user?.role === "Photographer") {
    redirect("/tpp-login/upload");
  }

  const role = normalizeRole(user.role);
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    links: group.links.filter((link) => hasAccess(role, link.minLevel))
  })).filter((group) => group.links.length > 0);

  return <AppShell groups={groups}>{children}</AppShell>;
}
