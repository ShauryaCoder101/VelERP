import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "../../../lib/session";
import Wordmark from "../../components/Wordmark";
import SignOutButton from "../../components/SignOutButton";

/* Same guard as the upload page's layout, deliberately duplicated rather than
   shared: these are the two doors into the firm's signed-in area, and a guard
   that lives in one of them is a guard that can be forgotten when a third is
   added. The checks themselves are repeated on every API this page calls. */

type LinksLayoutProps = {
  children: ReactNode;
};

export default async function LinksLayout({ children }: LinksLayoutProps) {
  const cookieStore = await cookies();
  const session = cookieStore.get("velocity_session");
  if (!session) {
    redirect("/tpp-login");
  }

  const user = await getSessionUser(
    new Request("http://localhost", {
      headers: { cookie: cookieStore.toString() }
    })
  );
  if (!user || user.role !== "Photographer") {
    redirect("/tpp-login");
  }

  return (
    <div className="auth-page">
      <div className="auth-card upload-card">
        <div className="auth-brand upload-brand">
          <Wordmark />
          <span className="upload-user">{user.name}</span>
        </div>
        {children}
        <div className="auth-foot">
          <SignOutButton />
          <span className="muted">Files are stored privately.</span>
        </div>
      </div>
    </div>
  );
}
