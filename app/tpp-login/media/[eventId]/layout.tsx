import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "../../../../lib/session";
import Wordmark from "../../../components/Wordmark";
import SignOutButton from "../../../components/SignOutButton";
/* Imported from the layout as well as the page: the masthead below is painted
   by this file, and it must be styled even on the states where the page bails
   out early. Next dedupes the two imports into one stylesheet for the route. */
import "./media.css";

/* Same door as app/tpp-login/upload/layout.tsx — a photographer session or
   nothing — but a different room. Uploading is a form and fits the narrow auth
   card; a gallery is a wall of photographs and needs the full page, so this
   borrows the client gallery's chrome (.share-page / .share-masthead /
   .share-main) rather than .auth-card.

   The redirect here is convenience, not security: every byte on this page comes
   from /api/photographer/media, which re-checks the session and the event grant
   on each request. */

export default async function PhotographerMediaLayout({ children }: { children: ReactNode }) {
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
    <div className="share-page">
      <header className="share-masthead">
        <Wordmark />
        <span className="tpp-masthead-end">
          <span className="share-masthead-label">{user.name}</span>
          <SignOutButton />
        </span>
      </header>

      <main className="share-main">{children}</main>
    </div>
  );
}
