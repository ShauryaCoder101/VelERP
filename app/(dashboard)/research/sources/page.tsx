"use client";

import { useEffect, useState } from "react";
import { humanise, when } from "../../../components/research/format";

/* What the tool listens to.

   Pausing a source stops the next poll and nothing else — everything already
   collected stays in the library. The one non-obvious column is "State": Reddit
   answers a burst of requests with a 429 and the tick then sits out a while, and
   an operator staring at a source that has not polled for an hour deserves to be
   told that rather than left guessing. */

type Source = {
  id: string;
  kind: string;
  identifier: string;
  label: string | null;
  enabled: boolean;
  pollIntervalMin: number;
  lastPolledAt: string | null;
  backoffUntil: string | null;
  settings: unknown;
  posts: number;
};

/* The poller only knows how to fetch these two by hand; youtube, clip and web
   arrive by other routes. */
const ADDABLE_KINDS = ["reddit", "rss"];

type AddForm = { kind: string; identifier: string; label: string; pollIntervalMin: string };

const EMPTY_ADD: AddForm = { kind: "reddit", identifier: "", label: "", pollIntervalMin: "60" };

const isBackingOff = (source: Source) =>
  !!source.backoffUntil && new Date(source.backoffUntil).getTime() > Date.now();

const SkeletonRows = () => (
  <div className="panel">
    <div className="panel-body">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="skeleton-table-row">
          <span className="skeleton skeleton-cell skeleton-cell-medium" />
          <span className="skeleton skeleton-cell skeleton-cell-wide" />
          <span className="skeleton skeleton-cell skeleton-cell-wide" />
          <span className="skeleton skeleton-cell skeleton-cell-medium" />
          <span className="skeleton skeleton-cell skeleton-cell-medium" />
        </div>
      ))}
    </div>
  </div>
);

export default function SourcesPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddForm>(EMPTY_ADD);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/research/sources");
      if (!response.ok) throw new Error(`The source list came back ${response.status}.`);
      const payload = (await response.json()) as Source[];
      setSources(Array.isArray(payload) ? payload : []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the sources.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /* Optimistic, because flipping a switch should feel instant; a failure puts
     the old row back and says so. */
  const patch = async (source: Source, body: Record<string, unknown>, optimistic: Partial<Source>) => {
    const before = source;
    setSources((prev) => prev.map((row) => (row.id === source.id ? { ...row, ...optimistic } : row)));
    setError(null);
    try {
      const response = await fetch(`/api/research/sources/${source.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json().catch(() => null)) as
        | (Partial<Source> & { error?: string })
        | null;
      if (!response.ok) throw new Error(payload?.error || `The update came back ${response.status}.`);
      if (payload) {
        setSources((prev) =>
          prev.map((row) => (row.id === source.id ? { ...row, ...payload, posts: row.posts } : row))
        );
      }
    } catch (caught) {
      setSources((prev) => prev.map((row) => (row.id === before.id ? before : row)));
      setError(caught instanceof Error ? caught.message : "The update did not go through.");
    }
  };

  const add = async () => {
    const identifier = addForm.identifier.trim();
    if (!identifier) {
      setAddError("An identifier is required.");
      return;
    }
    const interval = Number(addForm.pollIntervalMin);
    if (!Number.isFinite(interval) || interval < 0) {
      setAddError("The interval must be a number of minutes.");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const response = await fetch("/api/research/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: addForm.kind,
          identifier,
          label: addForm.label.trim() || undefined,
          pollIntervalMin: interval
        })
      });
      const payload = (await response.json().catch(() => null)) as
        | (Source & { error?: string })
        | null;
      if (!response.ok) {
        setAddError(payload?.error || `The source was not added (${response.status}).`);
        return;
      }
      setAddOpen(false);
      setAddForm(EMPTY_ADD);
      await load();
    } catch (caught) {
      setAddError(caught instanceof Error ? caught.message : "Could not reach the server.");
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Sources</h1>
          <p>What the tool listens to.</p>
        </div>
      </section>

      {error && <p className="rs-error">{error}</p>}

      {loading ? (
        <SkeletonRows />
      ) : (
        <section className="panel">
          <div className="claims-header">
            <h2>{sources.length} listed</h2>
            <button
              className="btn-primary"
              type="button"
              onClick={() => {
                setAddForm(EMPTY_ADD);
                setAddError(null);
                setAddOpen(true);
              }}
            >
              Add source
            </button>
          </div>
          <div className="panel-body">
            <div className="table-wrap">
              <table className="claims-table">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Label</th>
                    <th>Identifier</th>
                    <th>Every</th>
                    <th>Posts</th>
                    <th>Last polled</th>
                    <th>State</th>
                    <th>Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="empty-state">
                        Nothing is being listened to yet. Seed the starting list with{" "}
                        <code>node scripts/research-seed-sources.js</code>, or add one by hand.
                      </td>
                    </tr>
                  ) : (
                    sources.map((source) => {
                      const backing = isBackingOff(source);
                      return (
                        <tr key={source.id}>
                          <td>{humanise(source.kind)}</td>
                          <td>
                            <strong>{source.label || source.identifier}</strong>
                          </td>
                          <td>
                            <code style={{ fontSize: 12.5 }}>{source.identifier}</code>
                          </td>
                          <td>
                            {source.pollIntervalMin ? `${source.pollIntervalMin} min` : "—"}
                          </td>
                          <td>{source.posts}</td>
                          <td>{when(source.lastPolledAt)}</td>
                          <td>
                            {backing ? (
                              <>
                                <span
                                  className="status-pill inactive"
                                  title={`Reddit refused a request; the tick is sitting out until ${when(
                                    source.backoffUntil
                                  )}.`}
                                >
                                  backing off
                                </span>
                                <div className="cell-meta">
                                  Reddit refused a request. Waiting until {when(source.backoffUntil)}.
                                </div>
                                <button
                                  className="link-button hover-text"
                                  type="button"
                                  onClick={() =>
                                    void patch(source, { clearBackoff: true, enabled: source.enabled }, {
                                      backoffUntil: null
                                    })
                                  }
                                >
                                  Clear backoff
                                </button>
                              </>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>
                            <span
                              className={`status-pill ${source.enabled ? "active" : "inactive"}`}
                            >
                              {source.enabled ? "Enabled" : "Paused"}
                            </span>
                            <div>
                              <button
                                className="link-button hover-text"
                                type="button"
                                onClick={() =>
                                  void patch(source, { enabled: !source.enabled }, {
                                    enabled: !source.enabled
                                  })
                                }
                              >
                                {source.enabled ? "Pause" : "Enable"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {addOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Add source</h3>
            {addError && <p className="rs-error">{addError}</p>}

            <label className="auth-label">Kind</label>
            <select
              className="input select"
              value={addForm.kind}
              onChange={(e) => setAddForm((p) => ({ ...p, kind: e.target.value }))}
            >
              {ADDABLE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {humanise(kind)}
                </option>
              ))}
            </select>

            <label className="auth-label">Identifier</label>
            <input
              className="input"
              value={addForm.identifier}
              onChange={(e) => setAddForm((p) => ({ ...p, identifier: e.target.value }))}
              placeholder="eventprofs"
            />
            <p className="rs-hint">
              a subreddit name like <code>eventprofs</code>, or a full feed URL
            </p>

            <label className="auth-label">Label</label>
            <input
              className="input"
              value={addForm.label}
              onChange={(e) => setAddForm((p) => ({ ...p, label: e.target.value }))}
              placeholder="optional — defaults to the identifier"
            />

            <label className="auth-label">Poll every (minutes)</label>
            <input
              className="input"
              type="number"
              min={0}
              step={5}
              value={addForm.pollIntervalMin}
              onChange={(e) => setAddForm((p) => ({ ...p, pollIntervalMin: e.target.value }))}
            />

            <div className="modal-actions">
              <button
                className="btn-outline hover-text"
                type="button"
                onClick={() => setAddOpen(false)}
              >
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={add} disabled={adding}>
                {adding ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
