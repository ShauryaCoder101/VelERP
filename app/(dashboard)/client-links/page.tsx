"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import "./client-links.css";

/* Every open client link in the business, on one page.

   Links are minted per event, from the event page and now by photographers too,
   which means nobody has a view of what is currently out in the world. This is
   that view: what is shared, with whose name on it, and how long it has left.

   Open only — the API filters to revokedAt null and expiresAt in the future, so
   an empty table genuinely means nothing is shared right now. */

type ClientLink = {
  id: string;
  folder: string | null;
  token: string;
  expiresAt: string;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
  creator: { name: string; isPhotographer: boolean };
  event: { id: string; eventName: string; companyName: string } | null;
};

const DAY_MS = 86_400_000;

/** Days until a link stops working; 0 once it is inside its last day. */
const daysLeft = (expiresAt: string) =>
  Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / DAY_MS));

const EXPIRING_SOON_DAYS = 3;

/* The summary, the filter and the row all ask this one question, using the real
   remaining time rather than the rounded day count. Rounding disagreed with itself:
   a link 3.4 days out rounds up to 4 days ("4 days left") yet ceil-based arithmetic
   put some inside the window and not others, so the count and the filter could show
   different sets under the same "within 3 days" label. */
const isExpiringSoon = (expiresAt: string) =>
  new Date(expiresAt).getTime() - Date.now() <= EXPIRING_SOON_DAYS * DAY_MS;

const shortDate = (value: string) =>
  new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/* Rejections come back as JSON {error}; an auth or server failure is plain text, so fall
   back to a sentence of our own rather than rendering "undefined". */
const readError = async (res: Response, fallback: string) => {
  const text = await res.text().catch(() => "");
  if (!text) return fallback;
  try {
    const body = JSON.parse(text);
    return typeof body?.error === "string" ? body.error : fallback;
  } catch {
    return text;
  }
};

export default function ClientLinksPage() {
  const [links, setLinks] = useState<ClientLink[]>([]);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState("");
  const [tppOnly, setTppOnly] = useState(false);
  const [unopenedOnly, setUnopenedOnly] = useState(false);
  const [expiringOnly, setExpiringOnly] = useState(false);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClientLink | null>(null);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/share?all=1");
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setLinks(data.links ?? []);
        }
      } catch {
        /* an empty table with no error beats a crash; the page is read-mostly */
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = useMemo(() => {
    const events = new Set(links.map((l) => l.event?.id).filter(Boolean));
    const neverOpened = links.filter((l) => l.viewCount === 0).length;
    const soon = links.filter((l) => isExpiringSoon(l.expiresAt)).length;
    return { events: events.size, neverOpened, soon };
  }, [links]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return links.filter((l) => {
      if (q && !`${l.event?.eventName ?? ""} ${l.event?.companyName ?? ""}`.toLowerCase().includes(q)) return false;
      if (tppOnly && !l.creator.isPhotographer) return false;
      if (unopenedOnly && l.viewCount > 0) return false;
      if (expiringOnly && !isExpiringSoon(l.expiresAt)) return false;
      return true;
    });
  }, [links, query, tppOnly, unopenedOnly, expiringOnly]);

  const copy = async (link: ClientLink) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/share/${link.token}`);
      setCopiedId(link.id);
      window.setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Clipboard is blocked on insecure origins and in some embedded browsers; nothing
      // to recover from — the row is still there to try again from another browser.
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setActionError("");
    setBusy(true);
    try {
      const res = await fetch(`/api/share?id=${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" });
      if (!res.ok) {
        setActionError(await readError(res, "Could not delete this link."));
        return;
      }
      /* The server soft-revokes, so the row would not come back on a reload either —
         dropping it locally saves a round trip and keeps the summary honest. */
      setLinks((prev) => prev.filter((l) => l.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch {
      /* fetch only rejects on a transport failure; the link is almost certainly still
         open, so say so rather than leaving the dialog looking stuck. */
      setActionError("Could not reach the server. Check your connection and try again.");
    } finally {
      /* Always — otherwise a thrown request leaves the button disabled for good. */
      setBusy(false);
    }
  };

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Client links</h1>
          <p>
            Every client link that is currently open, across all events. Anyone holding one of these can view and
            download that media without signing in.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header claims-header">
          <div>
            <h2>Open links ({links.length})</h2>
            <p className="cl-summary">
              {links.length === 0
                ? "Nothing is shared with a client right now."
                : `${plural(links.length, "open link")} across ${plural(summary.events, "event")} · ` +
                  `${summary.neverOpened} never opened · ${summary.soon} expiring within ${EXPIRING_SOON_DAYS} days`}
            </p>
          </div>
          <div className="cl-toolbar">
            <input
              className="input cl-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search event or company"
              aria-label="Search by event name"
            />
            <label className="cl-toggle">
              <input type="checkbox" checked={tppOnly} onChange={(e) => setTppOnly(e.target.checked)} />
              Created by photographers
            </label>
            <label className="cl-toggle">
              <input type="checkbox" checked={unopenedOnly} onChange={(e) => setUnopenedOnly(e.target.checked)} />
              Never opened
            </label>
            <label className="cl-toggle">
              <input type="checkbox" checked={expiringOnly} onChange={(e) => setExpiringOnly(e.target.checked)} />
              Expiring within {EXPIRING_SOON_DAYS} days
            </label>
          </div>
        </div>
        <div className="panel-body">
          {loading ? (
            <p className="muted">Loading…</p>
          ) : links.length === 0 ? (
            <div className="empty-state">
              <p>No client links are open. Create one from the media section of an event.</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty-state">
              <p>No open links match these filters.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="team-table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Shared</th>
                    <th>Created by</th>
                    <th>Created</th>
                    <th>Expires</th>
                    <th>Opened</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((l) => {
                    const left = daysLeft(l.expiresAt);
                    const soon = isExpiringSoon(l.expiresAt);
                    return (
                      <tr key={l.id}>
                        <td className="cl-event-cell">
                          {l.event ? (
                            <>
                              <Link className="cl-event-link" href={`/events/${l.event.id}`}>
                                <strong>{l.event.eventName}</strong>
                              </Link>
                              <span>{l.event.companyName}</span>
                            </>
                          ) : (
                            <span className="muted">Event removed</span>
                          )}
                        </td>
                        <td>{l.folder || "Whole event"}</td>
                        <td className="cl-creator-cell">
                          <strong>{l.creator.name}</strong>
                          {l.creator.isPhotographer ? <span className="cl-badge">Photographer</span> : null}
                        </td>
                        <td className="muted">{shortDate(l.createdAt)}</td>
                        <td className={soon ? "cl-soon" : undefined}>
                          {left === 0 ? "Today" : `${plural(left, "day")} left`}
                        </td>
                        <td className={l.viewCount === 0 ? "cl-never" : undefined}>
                          {l.viewCount === 0 ? "not opened yet" : `${l.viewCount}×`}
                        </td>
                        <td>
                          <div className="cl-actions">
                            <button className="btn-outline hover-text" type="button" onClick={() => copy(l)}>
                              {copiedId === l.id ? "Copied" : "Copy link"}
                            </button>
                            <button
                              className="btn-outline hover-text"
                              type="button"
                              style={{ color: "var(--red)" }}
                              onClick={() => {
                                setActionError("");
                                setDeleteTarget(l);
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Delete a link — irreversible from the client's side, so it is confirmed. */}
      {deleteTarget && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          /* Ignore a backdrop click mid-delete: closing the dialog unmounts it, so a
             failing delete's setActionError would render into nothing and the user would
             never learn why it failed. Mirrors EventMedia's share-delete dialog. */
          onClick={() => {
            if (!busy) setDeleteTarget(null);
          }}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Delete this client link?</h3>
            <p>
              {deleteTarget.folder || "Whole event"}
              {deleteTarget.event ? (
                <>
                  {" "}
                  — <strong>{deleteTarget.event.eventName}</strong>
                </>
              ) : null}
            </p>
            <p className="muted">The client will no longer be able to open this link.</p>
            {actionError ? (
              <p className="auth-error" role="alert">
                {actionError}
              </p>
            ) : null}
            <div className="modal-actions">
              <button
                className="btn-outline hover-text"
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={handleDelete}
                disabled={busy}
                style={{ background: "var(--red)" }}
              >
                {busy ? "Deleting…" : "Delete link"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
