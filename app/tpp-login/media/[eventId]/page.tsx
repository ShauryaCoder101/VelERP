"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import MediaGallery, { type GalleryItem } from "../../../components/MediaGallery";
import "./media.css";

/* A photographer's view of one event they have been granted.
 *
 * Two rules shape this page, and both are enforced on the server as well:
 *
 *   1. They see EVERYTHING shot at the event, not only their own uploads — a
 *      second shooter has to know what the first already delivered. Their own
 *      files are marked, but nothing is hidden.
 *   2. It is read-only for media, and read-plus-create for client links. There
 *      is no delete, rename, move or replace control anywhere on this page:
 *      a photographer can never remove a photo, and can never withdraw a client
 *      link — only Velocity staff can. The link panel below therefore has a
 *      Copy button and no Delete.
 */

type EventInfo = { id: string; name: string; company: string; fromDate: string; toDate: string };

type Payload = { event: EventInfo; items: GalleryItem[] };

type ShareLink = {
  id: string;
  folder: string | null;
  token: string;
  expiresAt: string;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
  creator: { name: string; isPhotographer: boolean };
};

const DAY_MS = 86_400_000;

/* The media URLs this page renders are signed for an hour. Refreshed comfortably
   inside that window, so a gallery left open over a long cull never turns into a
   grid of broken images. */
const REFRESH_AFTER_MS = 50 * 60_000;

const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return iso;
  }
};

const fmtMoment = (iso: string | number) => {
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true
    });
  } catch {
    return "";
  }
};

export default function PhotographerMediaPage() {
  const { eventId } = useParams<{ eventId: string }>();

  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const [panelOpen, setPanelOpen] = useState(false);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [linksBusy, setLinksBusy] = useState(false);
  const [linksError, setLinksError] = useState("");

  const [folder, setFolder] = useState("");
  const [days, setDays] = useState(7);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [fresh, setFresh] = useState<{ url: string; expires: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  /* When the items on screen were last signed, so a tab returning to the
     foreground can tell a stale gallery from a fresh one. */
  const fetchedAt = useRef(0);

  const loadMedia = useCallback(
    async (quiet: boolean) => {
      try {
        const r = await fetch(`/api/photographer/media?eventId=${encodeURIComponent(eventId)}`);
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || "This event could not be opened.");
        fetchedAt.current = Date.now();
        /* Only the payload is replaced. The gallery keeps its own tab, open folder,
           selection and lightbox in component state, so re-signed items slot in
           underneath without the viewer losing their place. */
        setData(body as Payload);
        if (!quiet) setError("");
      } catch (e: unknown) {
        /* A failed background refresh is not worth tearing down a working gallery:
           the existing URLs are still valid until they age out. */
        if (!quiet) setError(e instanceof Error ? e.message : "This event could not be opened.");
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [eventId]
  );

  useEffect(() => {
    void loadMedia(false);
  }, [loadMedia]);

  /* Re-sign on a timer, and again whenever the tab comes back — a backgrounded tab
     throttles its timers, so returning after lunch would otherwise show dead links. */
  useEffect(() => {
    const refreshIfStale = () => {
      if (Date.now() - fetchedAt.current >= REFRESH_AFTER_MS) void loadMedia(true);
    };
    const timer = window.setInterval(refreshIfStale, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshIfStale();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refreshIfStale);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refreshIfStale);
    };
  }, [loadMedia]);

  useEffect(() => {
    document.title = data ? `${data.event.name} — Velocity` : "Velocity";
  }, [data]);

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPanelOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  /* Lazy signing for the in-browser ZIP. The session is the authorisation, and
     the grant is re-checked on every batch, so a grant withdrawn mid-download
     stops the next one. */
  const signIds = useCallback(
    async (ids: string[], signal: AbortSignal) => {
      const res = await fetch("/api/photographer/media/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, ids }),
        signal
      });
      if (!res.ok) throw new Error(`Media server returned ${res.status}`);
      const body = await res.json();
      return (body.urls ?? {}) as Record<string, string>;
    },
    [eventId]
  );

  const loadLinks = useCallback(async () => {
    setLinksBusy(true);
    setLinksError("");
    try {
      const res = await fetch(`/api/share?eventId=${encodeURIComponent(eventId)}`);
      if (!res.ok) {
        const said = await res.json().catch(() => null);
        throw new Error(said?.error || "Your links could not be loaded.");
      }
      setLinks((await res.json()) as ShareLink[]);
    } catch (e: unknown) {
      setLinks([]);
      setLinksError(e instanceof Error ? e.message : "Your links could not be loaded.");
    } finally {
      setLinksBusy(false);
    }
  }, [eventId]);

  const openPanel = () => {
    setPanelOpen(true);
    setCreateError("");
    void loadLinks();
  };

  const createLink = async () => {
    setCreating(true);
    setCreateError("");
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, folder: folder || null, days })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "The link could not be created.");
      setFresh({ url: `${window.location.origin}/share/${body.token}`, expires: body.expires });
      /* Not tracked means the link works but will not appear in the list below
         or in Velocity's tracker — worth saying rather than looking like a bug. */
      if (body.tracked === false) {
        setCreateError("The link works, but it could not be recorded — tell your Velocity contact about it.");
      }
      void loadLinks();
    } catch (e: unknown) {
      setFresh(null);
      setCreateError(e instanceof Error ? e.message : "The link could not be created.");
    } finally {
      setCreating(false);
    }
  };

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2500);
    } catch {
      /* the field is selectable as a fallback */
    }
  };

  /* Folder names come off the items themselves, so a link can be scoped to
     exactly the folder that was delivered. */
  const folders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of data?.items ?? []) {
      if (!item.folder) continue;
      counts.set(item.folder, (counts.get(item.folder) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  if (loading) {
    return <div className="share-state"><p className="muted">Opening gallery…</p></div>;
  }

  if (error || !data) {
    return (
      <div className="share-state">
        <h1>Not available</h1>
        <p className="muted">{error || "This event could not be opened."}</p>
        <p className="muted">
          You can only open events Velocity has handed over to you. Ask your Velocity contact to add you to this
          event.
        </p>
        <Link className="btn-outline" href="/tpp-login/upload">Back to upload</Link>
      </div>
    );
  }

  const { event, items } = data;
  const sameDay = fmtDate(event.fromDate) === fmtDate(event.toDate);

  return (
    <>
      <MediaGallery
        items={items}
        zipName={event.name}
        signIds={signIds}
        emptyMessage="Nothing has been uploaded to this event yet."
        header={
          <div className="share-head">
            <span className="share-eyebrow">{event.company}</span>
            <h1>{event.name}</h1>
            <p className="share-dates">
              {sameDay ? fmtDate(event.fromDate) : `${fmtDate(event.fromDate)} — ${fmtDate(event.toDate)}`}
            </p>
            <div className="tpp-head-actions">
              <button className="btn-primary" type="button" onClick={openPanel}>Client links</button>
              <Link className="btn-outline" href="/tpp-login/upload">Upload more</Link>
            </div>
          </div>
        }
        notice={
          <div className="share-notice">
            <span>Everything shot at this event, by whoever uploaded it.</span>
            <span className="share-notice-sub">
              {items.length} file{items.length !== 1 ? "s" : ""} · view, download and share. Removing anything is
              done by Velocity staff.
            </span>
          </div>
        }
      />

      {panelOpen && (
        <div className="modal-overlay" onClick={() => setPanelOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="claims-header">
              <h3>Client links</h3>
              <button className="link-button" type="button" onClick={() => setPanelOpen(false)}>Close</button>
            </div>

            {/* The server scopes this list to links this photographer created, so
                the heading says so. Reusing one is the reflex rather than minting
                another. There is no Delete here by design — only Velocity staff
                can withdraw a link. */}
            <div className="share-list">
              <div className="share-list-head">Links you&rsquo;ve created</div>
              {linksBusy && links.length === 0 ? (
                <div className="empty-state">Loading…</div>
              ) : links.length === 0 ? (
                <div className="empty-state">You haven&rsquo;t created a link for this event yet.</div>
              ) : (
                links.map((link) => {
                  const daysLeft = Math.max(0, Math.ceil((new Date(link.expiresAt).getTime() - Date.now()) / DAY_MS));
                  return (
                    <div key={link.id} className="share-row">
                      <div className="share-row-main">
                        <strong>{link.folder || "Whole event"}</strong>
                        <span className="muted">
                          {link.creator.name}
                          {link.creator.isPhotographer && <span className="tpp-badge">Photographer</span>}
                          {" · "}expires in {daysLeft} day{daysLeft !== 1 ? "s" : ""} ·{" "}
                          {link.viewCount === 0 ? "not opened yet" : `opened ${link.viewCount}×`}
                        </span>
                      </div>
                      <div className="share-row-actions">
                        <button
                          className="edit-btn"
                          type="button"
                          onClick={() => copy(`${window.location.origin}/share/${link.token}`, link.id)}
                        >
                          {copied === link.id ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {linksError && <div className="auth-error" role="alert">{linksError}</div>}

            <p className="muted">
              These are the links you&rsquo;ve created for this event. Anyone holding one can view and download that
              media — no sign-in, and nothing else about the event is shown. Ask your Velocity contact if a link
              needs to be withdrawn.
            </p>

            <label className="auth-label" htmlFor="tpp-share-scope">What to share</label>
            <select
              id="tpp-share-scope"
              className="input select"
              value={folder}
              disabled={creating}
              onChange={(e) => {
                setFolder(e.target.value);
                setFresh(null);
              }}
            >
              <option value="">Everything in this event ({items.length} files)</option>
              {folders.map((f) => (
                <option key={f.name} value={f.name}>{f.name} ({f.n} files)</option>
              ))}
            </select>

            <label className="auth-label" htmlFor="tpp-share-days">Expires after</label>
            <select
              id="tpp-share-days"
              className="input select"
              value={days}
              disabled={creating}
              onChange={(e) => {
                setDays(Number(e.target.value));
                setFresh(null);
              }}
            >
              <option value={2}>2 days (minimum)</option>
              <option value={5}>5 days</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={21}>21 days</option>
              <option value={30}>30 days (maximum)</option>
            </select>
            <span className="cell-meta">Pick the shortest window the client actually needs.</span>

            {fresh && (
              <>
                <label className="auth-label" htmlFor="tpp-share-link">Link</label>
                <input
                  id="tpp-share-link"
                  className="input share-link-field"
                  readOnly
                  value={fresh.url}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <span className="cell-meta">Stops working {fmtMoment(fresh.expires)}.</span>
              </>
            )}

            {createError && <div className="auth-error" role="alert">{createError}</div>}

            <div className="modal-actions">
              {fresh && (
                <button className="btn-outline" type="button" onClick={() => copy(fresh.url, "fresh")}>
                  {copied === "fresh" ? "Copied" : "Copy link"}
                </button>
              )}
              <button className="btn-primary" type="button" onClick={createLink} disabled={creating}>
                {creating ? "Creating…" : fresh ? "Create another link" : "Create link"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
