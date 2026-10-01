"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
/* The allowance strip and the "no events yet" card are the upload page's, and
   this page shows the same two things for the same reason. Imported rather than
   copied so the two can never disagree about what 1 TB looks like. */
import "../upload/upload.css";
import "./links.css";

/* The firm's open upload links: minting one, and the tracker.
 *
 * A link is a password-less URL that lets a photographer with no account upload
 * into this firm's folder on one event. That is the whole of what it is, and the
 * three consequences shape this page:
 *
 *   it spends the firm's 1 TB   so the allowance is the first thing shown, not
 *                               a footnote at the bottom of the form
 *   it is handed to a person    so every link expands into who has used it and
 *                               what each of them sent
 *   it cannot be taken back     by the firm. Only Velocity staff can close one,
 *                               the same rule as a client share link, so there
 *                               is no close control here — just the one line
 *                               saying who to ask.
 *
 * As everywhere a photographer can reach: nothing on this page deletes, renames
 * or moves anything.
 */

type EventOption = {
  id: string;
  eventName: string;
  companyName: string;
  fromDate: string;
  toDate: string;
};

type Quota = { usedBytes: number; quotaBytes: number };

type LinkStatus = "open" | "expired" | "revoked" | "paused";

type LinkSummary = {
  id: string;
  token: string;
  label: string | null;
  status: LinkStatus;
  event: { id: string; name: string };
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  contributors: number;
  files: number;
  bytes: number;
  lastUploadAt: string | null;
};

type FolderStat = { path: string; files: number; bytes: number };

type Person = {
  id: string;
  name: string;
  folder: string;
  createdAt: string;
  lastSeenAt: string | null;
  files: number;
  bytes: number;
  looseFiles: number;
  subfolders: FolderStat[];
  lastUploadAt: string | null;
};

type LinkDetail = Omit<LinkSummary, "contributors"> & {
  contributorCount: number;
  people: Person[];
};

const DAY_CHOICES = [7, 30, 90] as const;
const DEFAULT_DAYS = 30;

/* Storage is billed in decimal units and the quota is a round 1 TB — the same
   reasoning as the upload page, and the same numbers must come out. */
const GB = 1_000_000_000;

const formatBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatAllowance = (bytes: number) => {
  if (bytes >= 1_000 * GB) return `${(bytes / (1_000 * GB)).toFixed(bytes % (1_000 * GB) === 0 ? 0 : 2)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
};

const fmtMoment = (iso: string | null) => {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true
    });
  } catch {
    return iso;
  }
};

const fmtDay = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
};

/* "Closed by Velocity" rather than "Revoked": the firm cannot do it, so the
   word has to say who did. */
const STATUS_LABEL: Record<LinkStatus, string> = {
  open: "Open",
  expired: "Expired",
  revoked: "Closed by Velocity",
  paused: "Paused"
};

export default function PhotographerLinksPage() {
  const [events, setEvents] = useState<EventOption[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [links, setLinks] = useState<LinkSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState("");

  const [eventId, setEventId] = useState("");
  const [label, setLabel] = useState("");
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [fresh, setFresh] = useState<LinkSummary | null>(null);

  const [copied, setCopied] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LinkDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");

  /* The URL is built in the browser rather than returned by the server: the
     origin a firm should hand out is the one it is looking at. Read after mount
     so the markup is the same on both sides of hydration. */
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  const urlFor = (token: string) => `${origin}/upload/${token}`;

  const loadAccess = useCallback(async (): Promise<void> => {
    const res = await fetch("/api/photographer/events");
    if (!res.ok) {
      const said = await res.json().catch(() => null);
      throw new Error(said?.error || "Could not load your events");
    }
    const data: { events: EventOption[]; quota: Quota } = await res.json();
    setEvents(data.events);
    setQuota(data.quota);
    setEventId((prev) => (prev && data.events.some((e) => e.id === prev) ? prev : (data.events[0]?.id ?? "")));
  }, []);

  const loadLinks = useCallback(async (): Promise<void> => {
    const res = await fetch("/api/upload-links");
    if (!res.ok) {
      const said = await res.json().catch(() => null);
      throw new Error(said?.error || "Your links could not be loaded");
    }
    const data: { links: LinkSummary[] } = await res.json();
    setLinks(data.links);
  }, []);

  useEffect(() => {
    Promise.all([loadAccess(), loadLinks()])
      .catch((err) => setListError(err instanceof Error ? err.message : "This page could not be loaded"))
      .finally(() => setLoaded(true));
  }, [loadAccess, loadLinks]);

  const create = async () => {
    if (!eventId) {
      setCreateError("Choose the event this link is for.");
      return;
    }
    setCreating(true);
    setCreateError("");
    try {
      const res = await fetch("/api/upload-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, label: label.trim() || null, days })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "The link could not be created.");
      setFresh(body.link as LinkSummary);
      setLabel("");
      await loadLinks().catch(() => {});
    } catch (err) {
      setFresh(null);
      setCreateError(err instanceof Error ? err.message : "The link could not be created.");
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
      /* the field below is selectable as a fallback */
    }
  };

  /* One link open at a time. The detail is fetched fresh on every expand rather
     than cached: the numbers are the point of the screen, and a stale count is
     worse than a short wait. */
  const toggle = async (id: string) => {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    setDetailError("");
    setDetailBusy(true);
    try {
      const res = await fetch(`/api/upload-links/${encodeURIComponent(id)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "This link could not be opened.");
      setDetail(body as LinkDetail);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "This link could not be opened.");
    } finally {
      setDetailBusy(false);
    }
  };

  const usedPct = quota && quota.quotaBytes > 0 ? Math.min(100, (quota.usedBytes / quota.quotaBytes) * 100) : 0;

  return (
    <>
      <div className="page-header">
        <h1>Upload links</h1>
        <p>Let your photographers upload to an event without a Velocity login.</p>
      </div>

      <div className="upload-form">
        {quota && (
          <div className={`quota${usedPct >= 80 ? " quota-tight" : ""}`}>
            <div className="quota-line">
              <span>Storage used</span>
              <span className="quota-figure">
                {formatAllowance(quota.usedBytes)} of {formatAllowance(quota.quotaBytes)}
              </span>
            </div>
            <div
              className="quota-bar"
              role="progressbar"
              aria-label="Storage allowance used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(usedPct)}
            >
              <span style={{ width: `${usedPct}%` }} />
            </div>
            {/* The one number that decides whether another link is a good idea. */}
            <span className="cell-meta">
              Everything sent through every link counts against this one allowance.
            </span>
          </div>
        )}

        {loaded && events.length === 0 ? (
          <div className="upload-empty">
            <strong>No events yet</strong>
            <span className="muted">
              A link is for one event, so there is nothing to create one for yet. Ask your Velocity contact to add
              you to an event.
            </span>
          </div>
        ) : (
          <>
            <label className="auth-label" htmlFor="link-event">Event</label>
            <select
              id="link-event"
              className="input select"
              value={eventId}
              disabled={creating || !loaded}
              onChange={(e) => {
                setEventId(e.target.value);
                setFresh(null);
              }}
            >
              <option value="">Choose an event</option>
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.eventName} — {e.companyName}
                </option>
              ))}
            </select>

            <label className="auth-label" htmlFor="link-label">Label (optional)</label>
            <input
              id="link-label"
              className="input"
              value={label}
              maxLength={80}
              placeholder="Gujarat team"
              disabled={creating}
              onChange={(e) => setLabel(e.target.value)}
            />
            <span className="cell-meta">Only you and Velocity see this — it is how you tell your links apart.</span>

            <label className="auth-label" htmlFor="link-days">Stops working after</label>
            <select
              id="link-days"
              className="input select"
              value={days}
              disabled={creating}
              onChange={(e) => {
                setDays(Number(e.target.value));
                setFresh(null);
              }}
            >
              {DAY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {d} days{d === DEFAULT_DAYS ? " (default)" : ""}
                </option>
              ))}
            </select>

            {fresh && (
              <div className="link-fresh">
                <label className="auth-label" htmlFor="link-fresh-url">Share this link</label>
                <input
                  id="link-fresh-url"
                  className="input share-link-field"
                  readOnly
                  value={urlFor(fresh.token)}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <span className="cell-meta">
                  Anyone with it can upload to {fresh.event.name} until {fmtDay(fresh.expiresAt)}. They are asked
                  their name once, and everything they send goes into a folder of their own inside yours.
                </span>
              </div>
            )}

            {createError && <div className="auth-error" role="alert">{createError}</div>}

            <div className="link-create-actions">
              {fresh && (
                <button className="btn-outline" type="button" onClick={() => copy(urlFor(fresh.token), "fresh")}>
                  {copied === "fresh" ? "Copied" : "Copy link"}
                </button>
              )}
              <button className="btn-primary" type="button" onClick={create} disabled={creating || !loaded}>
                {creating ? "Creating…" : fresh ? "Create another link" : "Create link"}
              </button>
            </div>
          </>
        )}

        <div className="share-list link-list">
          <div className="share-list-head">Your links</div>
          {!loaded ? (
            <div className="empty-state">Loading…</div>
          ) : links.length === 0 ? (
            <div className="empty-state">You haven&rsquo;t created an upload link yet.</div>
          ) : (
            links.map((link) => {
              const expanded = openId === link.id;
              return (
                <div key={link.id} className="link-block">
                  <div className="share-row">
                    <div className="share-row-main">
                      <strong>{link.label || link.event.name}</strong>
                      <span className="muted">
                        {link.label ? `${link.event.name} · ` : ""}
                        {link.contributors} {link.contributors === 1 ? "person" : "people"} ·{" "}
                        {link.files} file{link.files !== 1 ? "s" : ""} · {formatBytes(link.bytes)}
                      </span>
                      <span className="muted">
                        {link.status === "revoked"
                          ? `Closed ${fmtDay(link.revokedAt ?? link.expiresAt)}`
                          : link.status === "expired"
                            ? `Expired ${fmtDay(link.expiresAt)}`
                            : `Expires ${fmtDay(link.expiresAt)}`}
                        {link.lastUploadAt && ` · last upload ${fmtMoment(link.lastUploadAt)}`}
                      </span>
                    </div>
                    <div className="share-row-actions link-row-actions">
                      <span className={`status-pill${link.status === "open" ? " active" : ""}`}>
                        {STATUS_LABEL[link.status]}
                      </span>
                      <button
                        className="edit-btn"
                        type="button"
                        onClick={() => copy(urlFor(link.token), link.id)}
                      >
                        {copied === link.id ? "Copied" : "Copy"}
                      </button>
                      <button
                        className="edit-btn"
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => void toggle(link.id)}
                      >
                        {expanded ? "Hide" : "Details"}
                      </button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="link-detail">
                      {detailBusy && <div className="empty-state">Loading…</div>}
                      {detailError && <div className="auth-error" role="alert">{detailError}</div>}
                      {detail && detail.id === link.id && (
                        detail.people.length === 0 ? (
                          <div className="empty-state">Nobody has opened this link yet.</div>
                        ) : (
                          detail.people.map((person) => (
                            <div key={person.id} className="link-person">
                              <div className="link-person-head">
                                <strong>{person.name}</strong>
                                <span className="link-person-figures">
                                  {person.files} file{person.files !== 1 ? "s" : ""} · {formatBytes(person.bytes)}
                                </span>
                              </div>
                              <span className="cell-meta link-person-folder">{person.folder}</span>
                              <span className="muted">
                                {person.looseFiles} loose file{person.looseFiles !== 1 ? "s" : ""} ·{" "}
                                {person.subfolders.length} folder{person.subfolders.length !== 1 ? "s" : ""}
                                {person.lastUploadAt
                                  ? ` · last upload ${fmtMoment(person.lastUploadAt)}`
                                  : " · nothing uploaded yet"}
                              </span>
                              {person.subfolders.length > 0 && (
                                <ul className="link-folders">
                                  {person.subfolders.map((folder) => (
                                    <li key={folder.path}>
                                      <span className="link-folder-path">{folder.path}</span>
                                      <span className="link-folder-figures">
                                        {folder.files} file{folder.files !== 1 ? "s" : ""} ·{" "}
                                        {formatBytes(folder.bytes)}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ))
                        )
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {listError && <div className="auth-error" role="alert">{listError}</div>}

        {/* Said once, quietly, rather than implied by the absence of a button. */}
        <p className="muted">
          A link stops working on its own when it expires. To close one early, ask your Velocity contact — only
          Velocity staff can close a link, and closing it never removes what was uploaded through it.
        </p>

        <div className="link-create-actions">
          <Link className="btn-outline" href="/tpp-login/upload">Back to upload</Link>
        </div>
      </div>
    </>
  );
}
