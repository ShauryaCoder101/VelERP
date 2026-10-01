"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import "./photographer-detail.css";

/* One firm's whole footprint, for staff.

   A firm has a single login but many photographers in the field, each working
   through an open upload link. That makes "has the footage arrived?" a question
   nobody could answer from the accounts table: it is per link, per person, per
   folder. This page is that answer — every link the firm minted, who used it,
   what they sent and where it landed, plus whatever the main login uploaded
   itself. Read-only apart from closing a link, which only staff may do. */

/* `outside` marks a folder that is NOT inside the firm's folder: uploads from
   before the firm folder existed, whose keys sit at the event root and are never
   rewritten. Tagged in the UI because the path alone is ambiguous — "Day 1" at
   the event root is a different folder from "Day 1" inside the firm's, and the
   two can both appear in this list. Optional: contributor stats never produce one. */
type FolderStat = { path: string; files: number; bytes: number; outside?: boolean };

type ContributorDetail = {
  id: string;
  name: string;
  /** Their folder name inside the firm folder, not the full path. */
  folder: string;
  createdAt: string;
  lastSeenAt: string | null;
  files: number;
  bytes: number;
  looseFiles: number;
  subfolders: FolderStat[];
  lastUploadAt: string | null;
};

type LinkStatus = "open" | "expired" | "revoked" | "paused";

type LinkDetail = {
  id: string;
  token: string;
  label: string | null;
  status: LinkStatus;
  event: { id: string; name: string };
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  contributorCount: number;
  people: ContributorDetail[];
  files: number;
  bytes: number;
  lastUploadAt: string | null;
};

type MainAccountStats = {
  event: { id: string; name: string };
  files: number;
  bytes: number;
  looseFiles: number;
  subfolders: FolderStat[];
  lastUploadAt: string | null;
};

type Activity = {
  photographer: { id: string; uid: string; name: string; folder: string; status: string };
  quota: { quotaBytes: number; allocatedBytes: number };
  links: LinkDetail[];
  mainAccount: MainAccountStats[];
};

const GB = 1_000_000_000;

const sizeLabel = (bytes: number) => {
  if (bytes <= 0) return "—";
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  if (bytes < GB) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;
};

const quotaLabel = (bytes: number) =>
  bytes >= 1_000_000_000_000 ? `${(bytes / 1_000_000_000_000).toFixed(0)} TB` : `${Math.round(bytes / GB)} GB`;

const shortDate = (value: string) =>
  new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const shortDateTime = (value: string | null) =>
  value === null
    ? "Never"
    : new Date(value).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit"
      });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

const STATUS_LABEL: Record<LinkStatus, string> = {
  open: "Open",
  expired: "Expired",
  revoked: "Closed",
  /* The tracker only ever reports a link's own state; "paused" is decided per
     request (firm deactivated, or its grant withdrawn) and is handled here only
     so an added status cannot render blank. */
  paused: "Paused"
};

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

export default function PhotographerDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : "";

  const [data, setData] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [expanded, setExpanded] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [closeTarget, setCloseTarget] = useState<LinkDetail | null>(null);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/photographers/${id}/activity`);
        if (!res.ok) {
          const message = await readError(res, "Could not load this photographer.");
          if (!cancelled) setLoadError(message);
        } else {
          const body = (await res.json()) as Activity;
          if (!cancelled) setData(body);
        }
      } catch {
        if (!cancelled) setLoadError("Could not reach the server. Check your connection and try again.");
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const summary = useMemo(() => {
    if (!data) return { open: 0, people: 0, files: 0, bytes: 0 };
    const linkTotals = data.links.reduce(
      (sum, link) => ({
        open: sum.open + (link.status === "open" ? 1 : 0),
        people: sum.people + link.contributorCount,
        files: sum.files + link.files,
        bytes: sum.bytes + link.bytes
      }),
      { open: 0, people: 0, files: 0, bytes: 0 }
    );
    // The firm's totals, not just the links': the main login's own uploads are
    // part of what this firm has sent and of what its quota is holding.
    return data.mainAccount.reduce(
      (sum, row) => ({ ...sum, files: sum.files + row.files, bytes: sum.bytes + row.bytes }),
      linkTotals
    );
  }, [data]);

  const copy = async (link: LinkDetail) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/upload/${link.token}`);
      setCopiedId(link.id);
      window.setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Clipboard is blocked on insecure origins and in some embedded browsers; nothing
      // to recover from — the row is still there to try again from another browser.
    }
  };

  const handleClose = async () => {
    if (!closeTarget) return;
    setActionError("");
    setBusy(true);
    try {
      const res = await fetch(`/api/upload-links/${encodeURIComponent(closeTarget.id)}`, { method: "DELETE" });
      if (!res.ok) {
        setActionError(await readError(res, "Could not close this link."));
        return;
      }
      /* Only on success, and only this row: the server soft-revokes, so every
         other figure on the page is still exactly what it was. */
      const revokedAt = new Date().toISOString();
      setData((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              links: prev.links.map((l) =>
                l.id === closeTarget.id ? { ...l, status: "revoked" as const, revokedAt } : l
              )
            }
      );
      setCloseTarget(null);
    } catch {
      setActionError("Could not reach the server. Check your connection and try again.");
    } finally {
      /* Always — otherwise a thrown request leaves the button disabled for good. */
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <section className="page-header">
        <Link className="pd-back" href="/photographers">
          ← Photographers
        </Link>
        <h1>Photographer</h1>
        <p>Loading…</p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="page-header">
        <Link className="pd-back" href="/photographers">
          ← Photographers
        </Link>
        <h1>Photographer</h1>
        <p role="alert">{loadError || "This photographer could not be found."}</p>
      </section>
    );
  }

  const { photographer, quota } = data;
  const pct = quota.quotaBytes > 0 ? Math.min(100, (quota.allocatedBytes / quota.quotaBytes) * 100) : 0;

  return (
    <>
      <section className="page-header">
        <Link className="pd-back" href="/photographers">
          ← Photographers
        </Link>
        <div className="pd-head">
          <div>
            <h1>{photographer.name}</h1>
            <p>
              {summary.open === 0 ? "No open links" : plural(summary.open, "open link")} ·{" "}
              {people(summary.people)} · {plural(summary.files, "file")} ·{" "}
              {sizeLabel(summary.bytes)}
            </p>
            <dl className="pd-facts">
              <div className="pd-fact">
                <dt>Photographer ID</dt>
                <dd>{photographer.uid}</dd>
              </div>
              <div className="pd-fact">
                <dt>Firm folder</dt>
                <dd className="pd-folder">{photographer.folder}</dd>
              </div>
              <div className="pd-fact">
                <dt>Account</dt>
                <dd>
                  <span className={`status-pill ${photographer.status === "ACTIVE" ? "active" : "inactive"}`}>
                    {photographer.status === "ACTIVE" ? "Active" : "Inactive"}
                  </span>
                </dd>
              </div>
            </dl>
          </div>
          <div className="pd-quota">
            <div className="pd-quota-label">
              <span>Storage used</span>
              <span>
                {sizeLabel(quota.allocatedBytes)} of {quotaLabel(quota.quotaBytes)}
              </span>
            </div>
            <div className="pd-quota-track">
              <div
                className={`pd-quota-fill${pct >= 100 ? " full" : pct >= 80 ? " warn" : ""}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Upload links ({data.links.length})</h2>
          <p className="muted">
            Anyone holding an open link can upload into this firm&apos;s folder without signing in. Everything they
            send counts against the firm&apos;s {quotaLabel(quota.quotaBytes)}.
          </p>
        </div>
        <div className="panel-body">
          {data.links.length === 0 ? (
            <div className="empty-state">
              <p>This firm has not created any upload links.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="team-table">
                <thead>
                  <tr>
                    <th>Link</th>
                    <th>Event</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Expires</th>
                    <th className="pd-num">People</th>
                    <th className="pd-num">Files</th>
                    <th className="pd-num">Size</th>
                    <th>Last upload</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.links.map((link) => {
                    const open = expanded === link.id;
                    return (
                      <Fragment key={link.id}>
                        <tr>
                          <td className="pd-link-cell">
                            <button
                              className="pd-expand"
                              type="button"
                              aria-expanded={open}
                              aria-label={open ? "Hide the people on this link" : "Show the people on this link"}
                              onClick={() => setExpanded(open ? null : link.id)}
                            >
                              {open ? "−" : "+"}
                            </button>
                            <strong>{link.label || "Untitled link"}</strong>
                            <span>{people(link.contributorCount)}</span>
                          </td>
                          <td>
                            <Link className="hover-text" href={`/events/${link.event.id}`}>
                              {link.event.name}
                            </Link>
                          </td>
                          <td>
                            <span className={`status-pill ${link.status === "open" ? "active" : "inactive"}`}>
                              {STATUS_LABEL[link.status]}
                            </span>
                          </td>
                          <td className="muted">{shortDate(link.createdAt)}</td>
                          <td className="muted">{shortDate(link.expiresAt)}</td>
                          <td className="pd-num">{link.contributorCount}</td>
                          <td className="pd-num">{link.files}</td>
                          <td className="pd-num">{sizeLabel(link.bytes)}</td>
                          <td className="muted">{shortDateTime(link.lastUploadAt)}</td>
                          <td>
                            <div className="pd-actions">
                              <button className="btn-outline hover-text" type="button" onClick={() => copy(link)}>
                                {copiedId === link.id ? "Copied" : "Copy link"}
                              </button>
                              {link.status === "revoked" ? null : (
                                <button
                                  className="btn-outline hover-text"
                                  type="button"
                                  style={{ color: "var(--red)" }}
                                  onClick={() => {
                                    setActionError("");
                                    setCloseTarget(link);
                                  }}
                                >
                                  Close link
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {open ? (
                          <tr className="pd-detail-row">
                            <td colSpan={10}>
                              {link.people.length === 0 ? (
                                <p className="pd-none">Nobody has opened this link yet.</p>
                              ) : (
                                <div className="pd-people">
                                  {link.people.map((person) => (
                                    <article className="pd-person" key={person.id}>
                                      <h4>{person.name}</h4>
                                      <span className="pd-person-folder">{person.folder}</span>
                                      <p className="pd-person-stats">
                                        {plural(person.files, "file")} · {sizeLabel(person.bytes)} ·{" "}
                                        {person.looseFiles} loose
                                        <br />
                                        Last upload {shortDateTime(person.lastUploadAt)} · last seen{" "}
                                        {shortDateTime(person.lastSeenAt)}
                                      </p>
                                      {person.subfolders.length > 0 ? (
                                        <div className="pd-subfolders">
                                          {person.subfolders.map((folder) => (
                                            <div className="pd-subfolder" key={folder.path}>
                                              <span>{folder.path}</span>
                                              <span>
                                                {folder.files} · {sizeLabel(folder.bytes)}
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      ) : null}
                                    </article>
                                  ))}
                                </div>
                              )}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-header">
          <h2>Main account uploads</h2>
          <p className="muted">
            What the firm&apos;s own login sent, per event — everything that did not come in through a link.
          </p>
        </div>
        <div className="panel-body">
          {data.mainAccount.length === 0 ? (
            <div className="empty-state">
              <p>The main login has not uploaded anything.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="team-table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th className="pd-num">Files</th>
                    <th className="pd-num">Size</th>
                    <th className="pd-num">Loose files</th>
                    <th>Folders</th>
                    <th>Last upload</th>
                  </tr>
                </thead>
                <tbody>
                  {data.mainAccount.map((row) => (
                    <tr key={row.event.id}>
                      <td>
                        <Link className="hover-text" href={`/events/${row.event.id}`}>
                          <strong>{row.event.name}</strong>
                        </Link>
                      </td>
                      <td className="pd-num">{row.files}</td>
                      <td className="pd-num">{sizeLabel(row.bytes)}</td>
                      <td className="pd-num">{row.looseFiles}</td>
                      <td>
                        {row.subfolders.length === 0 ? (
                          <span className="muted">No folders</span>
                        ) : (
                          <div className="pd-subfolders" style={{ marginTop: 0, borderTop: 0, paddingTop: 0 }}>
                            {row.subfolders.map((folder) => (
                              /* Keyed on both, because a stray folder and one
                                 inside the firm folder can share a path. */
                              <div className="pd-subfolder" key={`${folder.outside ? "out" : "in"}:${folder.path}`}>
                                <span>
                                  {folder.path}
                                  {folder.outside && (
                                    <span className="pd-outside">outside firm folder (older uploads)</span>
                                  )}
                                </span>
                                <span>
                                  {folder.files} · {sizeLabel(folder.bytes)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="muted">{shortDateTime(row.lastUploadAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Closing a link cannot be undone from the holder's side, so it is confirmed. */}
      {closeTarget && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          /* Ignore a backdrop click mid-close: unmounting the dialog would render a
             failing close's message into nothing and the user would never learn why. */
          onClick={() => {
            if (!busy) setCloseTarget(null);
          }}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Close this upload link?</h3>
            <p>
              {closeTarget.label || "Untitled link"} — <strong>{closeTarget.event.name}</strong>
            </p>
            <p className="muted">
              People using this link will no longer be able to upload. Files already uploaded stay.
            </p>
            {actionError ? (
              <p className="auth-error" role="alert">
                {actionError}
              </p>
            ) : null}
            <div className="modal-actions">
              <button
                className="btn-outline hover-text"
                type="button"
                onClick={() => setCloseTarget(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={handleClose}
                disabled={busy}
                style={{ background: "var(--red)" }}
              >
                {busy ? "Closing…" : "Close link"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
