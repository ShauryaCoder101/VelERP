import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import AccountantSidebar from "../components/AccountantSidebar";
import TopbarActions from "../components/TopbarActions";
import { getSessionUser } from "../../lib/session";

type AccountantLayoutProps = {
  children: ReactNode;
};

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
  if (user?.role === "Photographer") {
    redirect("/tpp-login/upload");
  }
  if (!user || user.role !== "Accountant") {
    redirect("/");
  }

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <img className="logo-image" src="/velocity-logo.png" alt="Velocity Logo" />
        </div>
        <AccountantSidebar />
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="brand">
            <img className="logo-image logo-topbar" src="/velocity-logo.png" alt="Velocity Logo" />
          </div>
          <TopbarActions />
        </header>

        <main className="content">{children}</main>

        <footer className="footer">
          <div className="footer-brand">
            <img className="logo-image" src="/velocity-logo.png" alt="Velocity Logo" />
          </div>
          <div className="footer-contact">
            <span>contact@erpsuite.com</span>
            <span>+1 234 567 890</span>
          </div>
          <div className="footer-copy">© 2026 Velocity Brand Server Pvt. Ltd. All rights reserved.</div>
        </footer>
      </div>
    </div>
  );
}
