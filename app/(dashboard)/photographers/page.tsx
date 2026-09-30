"use client";

import { useEffect, useMemo, useState } from "react";
import "./photographers.css";

type GrantedEvent = {
  eventId: string;
  eventName: string;
  companyName: string;
  fromDate: string;
  toDate: string;
  grantedBy: { id: string; name: string };
  grantedAt: string;
};

type Photographer = {
  id: string;
  uid: string;
  name: string;
  email: string;
  status: string;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  usedBytes: number;
  quotaBytes: number;
  events: GrantedEvent[];
};

type EventOption = {
  id: string;
  eventName: string;
  companyName: string;
  fromDate: string;
  toDate: string;
};

type Credentials = { name: string; email: string; password: string };

const PASSWORD_LENGTH = 16;
/* No 0/O/1/l/I: these get read off a screen and typed on a phone at a venue. */
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%&*";

const generatePassword = () => {
  const bytes = new Uint32Array(PASSWORD_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => PASSWORD_ALPHABET[n % PASSWORD_ALPHABET.length]).join("");
};

const GB = 1_000_000_000;

const usedLabel = (bytes: number) => {
  if (bytes <= 0) return "Nothing uploaded";
  if (bytes < GB) return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
  return `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;
};

const quotaLabel = (bytes: number) =>
  bytes >= 1_000_000_000_000 ? `${(bytes / 1_000_000_000_000).toFixed(0)} TB` : `${Math.round(bytes / GB)} GB`;

const dateRange = (from: string, to: string) => {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  const a = new Date(from).toLocaleDateString("en-IN", opts);
  const b = new Date(to).toLocaleDateString("en-IN", opts);
  return a === b ? a : `${a} – ${b}`;
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

export default function PhotographersPage() {
  const [photographers, setPhotographers] = useState<Photographer[]>([]);
  const [events, setEvents] = useState<EventOption[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(true);

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", email: "", password: "" });
  const [credentials, setCredentials] = useState<Credentials | null>(null);

  const [grantFor, setGrantFor] = useState<Photographer | null>(null);
  const [eventQuery, setEventQuery] = useState("");

  const [pwFor, setPwFor] = useState<Photographer | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [issuedPassword, setIssuedPassword] = useState<Credentials | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<{ photographer: Photographer; event: GrantedEvent } | null>(null);
  const [statusTarget, setStatusTarget] = useState<Photographer | null>(null);

  // Only ever one modal open at a time, so a single slot is enough for whichever save failed.
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async (includeInactive: boolean) => {
    const res = await fetch(`/api/photographers${includeInactive ? "?includeInactive=1" : ""}`);
    if (!res.ok) return;
    const data = await res.json();
    setPhotographers(data.photographers ?? []);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load(showInactive);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [showInactive]);

  useEffect(() => {
    /* The picker needs every event, not just the ones this employee is on — anyone may
       attach any event to a photographer. /api/events is open to all employees. */
    fetch("/api/events")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: EventOption[]) =>
        setEvents(
          rows.map((e) => ({
            id: e.id,
            eventName: e.eventName,
            companyName: e.companyName,
            fromDate: e.fromDate,
            toDate: e.toDate
          }))
        )
      )
      .catch(() => {});
  }, []);

  const grantable = useMemo(() => {
    if (!grantFor) return [];
    const already = new Set(grantFor.events.map((e) => e.eventId));
    const q = eventQuery.trim().toLowerCase();
    return events
      .filter((e) => !already.has(e.id))
      .filter((e) => !q || `${e.eventName} ${e.companyName}`.toLowerCase().includes(q))
      // /api/events already sorts fromDate desc; keep that so the shoot happening now is first.
      .slice(0, 60);
  }, [grantFor, events, eventQuery]);

  const closeModals = () => {
    setAddOpen(false);
    setCredentials(null);
    setGrantFor(null);
    setPwFor(null);
    setIssuedPassword(null);
    setRevokeTarget(null);
    setStatusTarget(null);
    setActionError("");
  };

  const handleCreate = async () => {
    setActionError("");
    setBusy(true);
    const res = await fetch("/api/photographers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(addForm)
    });
    setBusy(false);
    if (!res.ok) {
      setActionError(await readError(res, "Could not create this account."));
      return;
    }
    /* The plaintext password exists only in this tab — the server stores a bcrypt hash and
       will never hand it back, so the hand-off card is the one chance to pass it on. */
    setCredentials({ name: addForm.name, email: addForm.email.trim().toLowerCase(), password: addForm.password });
    setAddForm({ name: "", email: "", password: "" });
    await load(showInactive);
  };

  const handleGrant = async (eventId: string) => {
    if (!grantFor) return;
    setActionError("");
    setBusy(true);
    const res = await fetch(`/api/photographers/${grantFor.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId })
    });
    setBusy(false);
    if (!res.ok) {
      setActionError(await readError(res, "Could not give access to this event."));
      return;
    }
    setGrantFor(null);
    setEventQuery("");
    await load(showInactive);
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setActionError("");
    setBusy(true);
    const res = await fetch(
      `/api/photographers/${revokeTarget.photographer.id}/events/${revokeTarget.event.eventId}`,
      { method: "DELETE" }
    );
    setBusy(false);
    if (!res.ok) {
      setActionError(await readError(res, "Could not remove this access."));
      return;
    }
    setRevokeTarget(null);
    await load(showInactive);
  };

  const handleStatus = async () => {
    if (!statusTarget) return;
    const next = statusTarget.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    setActionError("");
    setBusy(true);
    const res = await fetch(`/api/photographers/${statusTarget.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next })
    });
    setBusy(false);
    if (!res.ok) {
      setActionError(await readError(res, "Could not change this account."));
      return;
    }
    setStatusTarget(null);
    await load(showInactive);
  };

  const handleResetPassword = async () => {
    if (!pwFor) return;
    setActionError("");
    setBusy(true);
    const res = await fetch(`/api/photographers/${pwFor.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPassword })
    });
    setBusy(false);
    if (!res.ok) {
      setActionError(await readError(res, "Could not reset the password."));
      return;
    }
    setIssuedPassword({ name: pwFor.name, email: pwFor.email, password: newPassword });
    setNewPassword("");
  };

  const loginUrl = typeof window === "undefined" ? "/tpp-login" : `${window.location.origin}/tpp-login`;

  return (
    <>
      <section className="page-header">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1>Photographers</h1>
            <p>
              Issue login credentials to third-party photographers and choose which events each one may upload to.
              They see nothing else in the ERP.
            </p>
          </div>
          <button
            className="btn-primary"
            type="button"
            onClick={() => {
              closeModals();
              setAddForm({ name: "", email: "", password: "" });
              setAddOpen(true);
            }}
          >
            + Add photographer
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header claims-header">
          <div>
            <h2>Photographer accounts ({photographers.length})</h2>
            <p className="muted">Every account is capped at {quotaLabel(1_000_000_000_000)} of uploads.</p>
          </div>
          <div className="tpp-toolbar">
            <label className="tpp-toggle">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Show deactivated
            </label>
          </div>
        </div>
        <div className="panel-body">
          {loading ? (
            <p className="muted">Loading…</p>
          ) : photographers.length === 0 ? (
            <div className="empty-state">
              <p>No photographer accounts yet. Add one to hand out upload credentials.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="team-table">
                <thead>
                  <tr>
                    <th>Photographer</th>
                    <th>Login email</th>
                    <th>Events they can upload to</th>
                    <th>Storage used</th>
                    <th>Created by</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {photographers.map((p) => {
                    const pct = p.quotaBytes > 0 ? Math.min(100, (p.usedBytes / p.quotaBytes) * 100) : 0;
                    return (
                      <tr key={p.id}>
                        <td className="tpp-name-cell">
                          <strong>{p.name}</strong>
                          <span>{p.uid}</span>
                        </td>
                        <td>{p.email}</td>
                        <td>
                          <div className="tpp-chips">
                            {p.events.length === 0 ? (
                              <span className="muted" style={{ fontSize: 12.5 }}>
                                No events yet
                              </span>
                            ) : (
                              p.events.map((ev) => (
                                <span
                                  className="tpp-chip"
                                  key={ev.eventId}
                                  title={`${ev.companyName} · granted by ${ev.grantedBy.name}`}
                                >
                                  {ev.eventName}
                                  <button
                                    className="tpp-chip-x"
                                    type="button"
                                    aria-label={`Remove access to ${ev.eventName}`}
                                    onClick={() => {
                                      closeModals();
                                      setRevokeTarget({ photographer: p, event: ev });
                                    }}
                                  >
                                    ×
                                  </button>
                                </span>
                              ))
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="tpp-quota">
                            <div className="tpp-quota-label">
                              {usedLabel(p.usedBytes)} of {quotaLabel(p.quotaBytes)}
                            </div>
                            <div className="tpp-quota-track">
                              <div
                                className={`tpp-quota-fill${pct >= 100 ? " full" : pct >= 80 ? " warn" : ""}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="muted">{p.createdBy?.name ?? "—"}</td>
                        <td>
                          <span className={`status-pill ${p.status === "ACTIVE" ? "active" : "inactive"}`}>
                            {p.status === "ACTIVE" ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td>
                          <div className="tpp-actions">
                            {p.status === "ACTIVE" && (
                              <button
                                className="btn-outline hover-text"
                                type="button"
                                onClick={() => {
                                  closeModals();
                                  setEventQuery("");
                                  setGrantFor(p);
                                }}
                              >
                                Give access
                              </button>
                            )}
                            <button
                              className="btn-outline hover-text"
                              type="button"
                              onClick={() => {
                                closeModals();
                                setNewPassword("");
                                setPwFor(p);
                              }}
                            >
                              Reset password
                            </button>
                            <button
                              className="btn-outline hover-text"
                              type="button"
                              style={p.status === "ACTIVE" ? { color: "var(--red)" } : undefined}
                              onClick={() => {
                                closeModals();
                                setStatusTarget(p);
                              }}
                            >
                              {p.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
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

      {/* Add photographer — becomes the credential hand-off once the account exists. */}
      {addOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 480, maxHeight: "90vh", overflowY: "auto" }}>
            {credentials ? (
              <>
                <h3>Account created</h3>
                <p className="muted">
                  Send these to {credentials.name} now. The password is not stored anywhere and will not be shown
                  again.
                </p>
                <div className="tpp-cred">
                  <CredentialRow label="Login URL" value={loginUrl} />
                  <CredentialRow label="Email" value={credentials.email} />
                  <CredentialRow label="Password" value={credentials.password} />
                </div>
                <div className="modal-actions">
                  <button className="btn-primary" type="button" onClick={closeModals}>
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>Add photographer</h3>
                <p className="muted">They will only be able to upload to the events you give them.</p>
                <label className="auth-label" htmlFor="tpp-name">
                  Full name
                </label>
                <input
                  id="tpp-name"
                  className="input"
                  value={addForm.name}
                  onChange={(e) => setAddForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Rahul Mehta"
                />
                <label className="auth-label" htmlFor="tpp-email">
                  Email (this is their login ID)
                </label>
                <input
                  id="tpp-email"
                  className="input"
                  type="email"
                  value={addForm.email}
                  onChange={(e) => setAddForm((p) => ({ ...p, email: e.target.value }))}
                  placeholder="rahul@studio.com"
                />
                <label className="auth-label" htmlFor="tpp-password">
                  Password (at least 10 characters)
                </label>
                <div className="tpp-pw-row">
                  <input
                    id="tpp-password"
                    className="input"
                    type="text"
                    value={addForm.password}
                    onChange={(e) => setAddForm((p) => ({ ...p, password: e.target.value }))}
                    placeholder="Generate or type one"
                  />
                  <button
                    className="btn-outline hover-text"
                    type="button"
                    onClick={() => setAddForm((p) => ({ ...p, password: generatePassword() }))}
                  >
                    Generate
                  </button>
                </div>
                {actionError ? (
                  <p className="auth-error" role="alert">
                    {actionError}
                  </p>
                ) : null}
                <div className="modal-actions">
                  <button className="btn-outline hover-text" type="button" onClick={closeModals}>
                    Cancel
                  </button>
                  <button
                    className="btn-primary"
                    type="button"
                    onClick={handleCreate}
                    disabled={busy || !addForm.name.trim() || !addForm.email.trim() || addForm.password.length < 10}
                  >
                    {busy ? "Creating…" : "Create account"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Give access to an event */}
      {grantFor && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 520, maxHeight: "90vh", overflowY: "auto" }}>
            <h3>Give access to an event</h3>
            <p className="muted">
              {grantFor.name} ({grantFor.uid}) will be able to upload photos and video to whichever event you pick.
            </p>
            <label className="auth-label" htmlFor="tpp-event-search">
              Search events
            </label>
            <input
              id="tpp-event-search"
              className="input"
              value={eventQuery}
              onChange={(e) => setEventQuery(e.target.value)}
              placeholder="Event or company name"
            />
            <div className="tpp-picker-list">
              {grantable.length === 0 ? (
                <p className="tpp-picker-empty">
                  {eventQuery ? "No events match that search." : "No events left to add."}
                </p>
              ) : (
                grantable.map((ev) => (
                  <button
                    className="tpp-picker-option"
                    type="button"
                    key={ev.id}
                    disabled={busy}
                    onClick={() => handleGrant(ev.id)}
                  >
                    <strong>{ev.eventName}</strong>
                    <span>
                      {ev.companyName} · {dateRange(ev.fromDate, ev.toDate)}
                    </span>
                  </button>
                ))
              )}
            </div>
            {actionError ? (
              <p className="auth-error" role="alert">
                {actionError}
              </p>
            ) : null}
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={closeModals}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset password — shows the new one once, same as creation. */}
      {pwFor && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 480 }}>
            {issuedPassword ? (
              <>
                <h3>Password reset</h3>
                <p className="muted">
                  {issuedPassword.name} has been signed out everywhere. Send them the new password — it will not be
                  shown again.
                </p>
                <div className="tpp-cred">
                  <CredentialRow label="Login URL" value={loginUrl} />
                  <CredentialRow label="Email" value={issuedPassword.email} />
                  <CredentialRow label="Password" value={issuedPassword.password} />
                </div>
                <div className="modal-actions">
                  <button className="btn-primary" type="button" onClick={closeModals}>
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>Reset password</h3>
                <p className="muted">
                  New password for {pwFor.name} ({pwFor.email}). This signs them out of any open session.
                </p>
                <label className="auth-label" htmlFor="tpp-new-password">
                  New password (at least 10 characters)
                </label>
                <div className="tpp-pw-row">
                  <input
                    id="tpp-new-password"
                    className="input"
                    type="text"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Generate or type one"
                  />
                  <button className="btn-outline hover-text" type="button" onClick={() => setNewPassword(generatePassword())}>
                    Generate
                  </button>
                </div>
                {actionError ? (
                  <p className="auth-error" role="alert">
                    {actionError}
                  </p>
                ) : null}
                <div className="modal-actions">
                  <button className="btn-outline hover-text" type="button" onClick={closeModals}>
                    Cancel
                  </button>
                  <button
                    className="btn-primary"
                    type="button"
                    onClick={handleResetPassword}
                    disabled={busy || newPassword.length < 10}
                  >
                    {busy ? "Saving…" : "Save password"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Remove access */}
      {revokeTarget && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Remove access</h3>
            <p>
              Stop <strong>{revokeTarget.photographer.name}</strong> from uploading to{" "}
              <strong>{revokeTarget.event.eventName}</strong>?
            </p>
            <p className="muted">
              Photos already uploaded stay on the event. Access can be given back at any time.
            </p>
            {actionError ? (
              <p className="auth-error" role="alert">
                {actionError}
              </p>
            ) : null}
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={closeModals}>
                Cancel
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={handleRevoke}
                disabled={busy}
                style={{ background: "var(--red)" }}
              >
                {busy ? "Removing…" : "Remove access"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Deactivate / reactivate */}
      {statusTarget && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>{statusTarget.status === "ACTIVE" ? "Deactivate account" : "Reactivate account"}</h3>
            {statusTarget.status === "ACTIVE" ? (
              <>
                <p>
                  Deactivate <strong>{statusTarget.name}</strong> ({statusTarget.email})?
                </p>
                <p className="muted">
                  They will be signed out immediately and cannot log in or upload. Their photos stay on the events.
                </p>
              </>
            ) : (
              <>
                <p>
                  Reactivate <strong>{statusTarget.name}</strong> ({statusTarget.email})?
                </p>
                <p className="muted">
                  They will be able to log in again with their existing password and upload to the events they still
                  have access to.
                </p>
              </>
            )}
            {actionError ? (
              <p className="auth-error" role="alert">
                {actionError}
              </p>
            ) : null}
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={closeModals}>
                Cancel
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={handleStatus}
                disabled={busy}
                style={statusTarget.status === "ACTIVE" ? { background: "var(--red)" } : undefined}
              >
                {statusTarget.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CredentialRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is blocked on insecure origins and in some embedded browsers; the value
      // is on screen and selectable, so there is nothing to recover from.
    }
  };
  return (
    <div className="tpp-cred-row">
      <span className="tpp-cred-label">{label}</span>
      <span className="tpp-cred-value">{value}</span>
      <button className="tpp-cred-copy" type="button" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
