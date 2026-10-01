import type { ReactNode } from "react";
import Wordmark from "../../components/Wordmark";

/* The chrome around an open upload link.
 *
 * Deliberately the thinnest layout in the app: no cookies are read, no session
 * is fetched, nothing is redirected. The token in the URL is the whole
 * authorisation and it is checked by the API on every single request the page
 * makes, so a layout that tried to gate anything here would only be duplicating
 * a check it cannot do correctly (it does not hold the contributor credential —
 * that lives in the browser).
 *
 * Borrowed from app/share/[token] rather than the auth card: this page carries
 * a gallery of the firm's work underneath the uploader, and a gallery needs the
 * full width. Nothing in this masthead links anywhere — a contributor has no
 * account, no other events and nothing else in the ERP to reach.
 */

export const metadata = {
  title: "Upload — Velocity",
  /* A bearer URL that anyone in a WhatsApp group might forward. Keeping it out
     of search results costs nothing and the page has no reason to be indexed. */
  robots: { index: false, follow: false }
};

export default function PublicUploadLayout({ children }: { children: ReactNode }) {
  return (
    <div className="share-page">
      <header className="share-masthead">
        <Wordmark />
        <span className="share-masthead-label">Media upload</span>
      </header>

      <main className="share-main">{children}</main>

      <footer className="share-foot">
        <span>Velocity Brand Server Pvt. Ltd.</span>
        <span>contact@velocityindia.net · +91 93197 13708</span>
      </footer>
    </div>
  );
}
