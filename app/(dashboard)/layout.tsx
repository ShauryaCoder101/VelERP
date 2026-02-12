import type { ReactNode } from "react";
import SidebarNav from "../components/SidebarNav";
import { currentUser } from "../../lib/auth";

type DashboardLayoutProps = {
  children: ReactNode;
};

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo-badge">E</span>
        </div>
        <SidebarNav />
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="brand">
            <span className="logo-badge">E</span>
            <span className="brand-name">ERPSuite</span>
          </div>
          <div className="topbar-actions">
            <button className="icon-button hover-text" type="button" aria-label="Notifications">
              <span className="bell" />
              <span className="status-dot" />
            </button>
            <button className="profile-button hover-text" type="button">
              <span className="avatar">U</span>
              <span className="profile-name">{currentUser.name}</span>
              <span className="chevron" aria-hidden="true" />
            </button>
          </div>
        </header>

        <main className="content">{children}</main>

        <footer className="footer">
          <div className="footer-brand">
            <span className="logo-badge">E</span>
            <span>ERPSuite</span>
          </div>
          <div className="footer-contact">
            <span>contact@erpsuite.com</span>
            <span>+1 234 567 890</span>
          </div>
          <div className="footer-copy">© 2026 ERPSuite. All rights reserved.</div>
        </footer>
      </div>
    </div>
  );
}
