"use client";

import { useEffect, useState } from "react";
import { dash, humanise, when } from "../../../components/research/format";

/* The operational view: what the pipeline has ingested, skipped and choked on.

   Everything here reads defensively. A triage verdict is whatever the cheap
   model returned at the time, so a key that existed last month may be missing
   on an older row, and the counters are a groupBy — a status nobody has hit yet
   simply is not in the object. */

type Post = {
  id: string;
  kind: string;
  externalId: string;
  title: string | null;
  url: string | null;
  status: string;
  error: string | null;
  triage: Triage | null;
  fetchedAt: string | null;
  processedAt: string | null;
};

/* The triage verdict as the cheap model actually writes it. The longer names
   (scope_category / agency_deliverable / india_feasible) are accepted as well,
   because that is what the prompt calls them in prose and a future prompt may
   start emitting them. */
type Triage = {
  accepted?: boolean;
  verdict?: string;
  reason?: string;
  stage?: string;
  domain_relevant?: string | boolean;
  category?: string;
  scope_category?: string;
  corporate_fit?: string | boolean;
  agency_deliverable?: string | boolean;
  india_fit?: string | boolean;
  india_feasible?: string | boolean;
  model?: string;
};

type Search = {
  id: string;
  needText: string | null;
  filters: Record<string, unknown> | null;
  createdAt: string | null;
};

type Counts = Record<string, number>;

type Admin = {
  rawPosts: Counts;
  ideas: Counts;
  jobs: Counts;
  failed: Post[];
  triageRejected: Post[];
  triageAccepted: Post[];
  searches: Search[];
};

type Tick = {
  ranAt?: string;
  elapsedMs?: number;
  polled?: Array<{ source?: string; fetched?: number; inserted?: number; updated?: number }>;
  processed?: Record<string, number>;
  job?: { jobId?: string; phase?: string; status?: string } | null;
  notes?: string[];
  geminiConfigured?: boolean;
};

/* The order an operator thinks in: newest first, wreckage last. Anything the
   backend adds later is appended rather than dropped. */
const POST_STATUS_ORDER = [
  "new",
  "awaiting_comments",
  "skipped",
  "rejected",
  "extracted",
  "failed"
];
const IDEA_STATUS_ORDER = ["active", "rejected", "merged"];
const JOB_STATUS_ORDER = ["queued", "running", "done", "failed"];

const ordered = (counts: Counts | undefined, first: string[]): Array<[string, number]> => {
  const rows = counts ?? {};
  const known = first.filter((key) => key in rows).map((key) => [key, rows[key]] as [string, number]);
  const rest = Object.keys(rows)
    .filter((key) => !first.includes(key))
    .sort()
    .map((key) => [key, rows[key]] as [string, number]);
  return [...known, ...rest];
};

const truncate = (value: string | null | undefined, max: number): string => {
  if (!value) return "—";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** Filters as "audience: 200, setting: indoor" — only the ones that carry a value. */
const filterSummary = (filters: Record<string, unknown> | null | undefined): string => {
  if (!filters || typeof filters !== "object") return "—";
  const parts = Object.entries(filters)
    .filter(([, value]) => {
      if (value === null || value === undefined || value === "") return false;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    })
    .map(([key, value]) => `${humanise(key)}: ${dash(value)}`);
  return parts.length ? parts.join(", ") : "—";
};

const tickLine = (tick: Tick): string => {
  const seconds = typeof tick.elapsedMs === "number" ? (tick.elapsedMs / 1000).toFixed(1) : "?";
  const polled = Array.isArray(tick.polled) ? tick.polled.length : 0;
  const fetched = Array.isArray(tick.polled)
    ? tick.polled.reduce((sum, row) => sum + (row?.inserted ?? 0), 0)
    : 0;
  const processed = tick.processed ?? {};
  const bits = [
    `${polled} source${polled === 1 ? "" : "s"} polled`,
    `${fetched} new post${fetched === 1 ? "" : "s"}`,
    `${processed.processed ?? 0} processed`,
    `${processed.ideas_created ?? 0} new idea${(processed.ideas_created ?? 0) === 1 ? "" : "s"}`
  ];
  return `Tick finished in ${seconds}s — ${bits.join(", ")}.`;
};

const TriageCell = ({ value }: { value: unknown }) => <>{dash(value)}</>;

const TriageTable = ({ posts }: { posts: Post[] }) => (
  <div className="table-wrap">
    <table className="claims-table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Kind</th>
          <th>Stage</th>
          <th>Domain</th>
          <th>Category</th>
          <th>Corporate</th>
          <th>India</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {posts.length === 0 ? (
          <tr>
            <td colSpan={8} className="empty-state">
              Nothing here yet.
            </td>
          </tr>
        ) : (
          posts.map((post) => {
            const triage = post.triage ?? {};
            const title = truncate(post.title, 70);
            return (
              <tr key={post.id}>
                <td>
                  {post.url ? (
                    <a
                      href={post.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover-text"
                      title={post.title ?? undefined}
                    >
                      {title}
                    </a>
                  ) : (
                    <span title={post.title ?? undefined}>{title}</span>
                  )}
                </td>
                <td>{humanise(post.kind) || "—"}</td>
                <td>{dash(triage.stage)}</td>
                <td>
                  <TriageCell value={triage.domain_relevant} />
                </td>
                <td>
                  {triage.category ?? triage.scope_category
                    ? humanise(triage.category ?? triage.scope_category)
                    : "—"}
                </td>
                <td>
                  <TriageCell value={triage.corporate_fit ?? triage.agency_deliverable} />
                </td>
                <td>
                  <TriageCell value={triage.india_fit ?? triage.india_feasible} />
                </td>
                <td title={triage.reason ?? undefined}>{truncate(triage.reason, 140)}</td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  </div>
);

const Skeleton = () => (
  <>
    <section className="stats-grid">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className="skeleton-stat-card">
          <div>
            <div className="skeleton skeleton-stat-value" />
            <div className="skeleton skeleton-stat-label" />
          </div>
        </div>
      ))}
    </section>
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-body">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton-table-row">
            <span className="skeleton skeleton-cell skeleton-cell-wide" />
            <span className="skeleton skeleton-cell skeleton-cell-medium" />
            <span className="skeleton skeleton-cell skeleton-cell-medium" />
          </div>
        ))}
      </div>
    </section>
  </>
);

export default function ResearchAdminPage() {
  const [data, setData] = useState<Admin | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tick, setTick] = useState<Tick | null>(null);

  const load = async (showSkeleton: boolean) => {
    if (showSkeleton) setLoading(true);
    try {
      const response = await fetch("/api/research/admin");
      if (!response.ok) throw new Error(`The pipeline view came back ${response.status}.`);
      setData((await response.json()) as Admin);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the pipeline view.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(true);
  }, []);

  const run = async (action: "retry-failed" | "retriage" | "tick") => {
    setBusy(action);
    setError(null);
    setMessage(null);
    if (action === "tick") setTick(null);
    try {
      const response = await fetch("/api/research/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const payload = (await response.json().catch(() => null)) as
        | { requeued?: number; tick?: Tick; error?: string }
        | null;
      if (!response.ok) {
        setError(payload?.error || `That did not work (${response.status}).`);
        return;
      }
      if (payload?.tick) {
        setTick(payload.tick);
      } else if (typeof payload?.requeued === "number") {
        setMessage(`Requeued ${payload.requeued} post${payload.requeued === 1 ? "" : "s"}.`);
      }
      await load(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reach the pipeline.");
    } finally {
      setBusy(null);
    }
  };

  const confirmRequeue = (action: "retry-failed" | "retriage") => {
    const count =
      action === "retry-failed" ? data?.rawPosts?.failed ?? 0 : data?.rawPosts?.rejected ?? 0;
    const what = action === "retry-failed" ? "failed" : "rejected";
    const ok = window.confirm(
      `This will put ${count} ${what} post${count === 1 ? "" : "s"} back in the queue. Go ahead?`
    );
    if (ok) void run(action);
  };

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Pipeline</h1>
          <p>What the pipeline has ingested, skipped and choked on.</p>
        </div>
      </section>

      {error && <p className="rs-error">{error}</p>}

      {loading ? (
        <Skeleton />
      ) : (
        <>
          <section className="stats-grid">
            {ordered(data?.rawPosts, POST_STATUS_ORDER).map(([status, count]) => (
              <div key={`post-${status}`} className="stat-card">
                <div className="stat-content">
                  <div className="stat-value">{count}</div>
                  <div className="stat-label">Posts · {humanise(status)}</div>
                </div>
              </div>
            ))}
            {ordered(data?.ideas, IDEA_STATUS_ORDER).map(([status, count]) => (
              <div key={`idea-${status}`} className="stat-card">
                <div className="stat-content">
                  <div className="stat-value">{count}</div>
                  <div className="stat-label">Ideas · {humanise(status)}</div>
                </div>
              </div>
            ))}
            {ordered(data?.jobs, JOB_STATUS_ORDER).map(([status, count]) => (
              <div key={`job-${status}`} className="stat-card">
                <div className="stat-content">
                  <div className="stat-value">{count}</div>
                  <div className="stat-label">Research jobs · {humanise(status)}</div>
                </div>
              </div>
            ))}
          </section>

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="claims-actions">
              <button
                className="btn-primary"
                type="button"
                disabled={busy !== null}
                onClick={() => void run("tick")}
              >
                {busy === "tick" ? "Running…" : "Run tick now"}
              </button>
              <button
                className="btn-outline hover-text"
                type="button"
                disabled={busy !== null}
                onClick={() => confirmRequeue("retry-failed")}
              >
                {busy === "retry-failed" ? "Requeueing…" : "Retry failed"}
              </button>
              <button
                className="btn-outline hover-text"
                type="button"
                disabled={busy !== null}
                onClick={() => confirmRequeue("retriage")}
              >
                {busy === "retriage" ? "Requeueing…" : "Re-triage rejected"}
              </button>
            </div>

            {busy === "tick" && (
              <p className="rs-hint" style={{ marginTop: 12 }}>
                A tick can take up to half a minute. Leave this open.
              </p>
            )}

            {message && (
              <p className="rs-hint" style={{ marginTop: 12 }}>
                {message}
              </p>
            )}

            {tick && (
              <div style={{ marginTop: 12 }}>
                <p className="rs-hint">
                  {tickLine(tick)}
                  {tick.geminiConfigured === false && " Gemini is not configured."}
                </p>
                {Array.isArray(tick.notes) && tick.notes.length > 0 && (
                  <p className="rs-hint" style={{ marginTop: 6 }}>
                    {tick.notes.join(" · ")}
                  </p>
                )}
                <details className="rs-queries">
                  <summary>The whole thing</summary>
                  <pre
                    style={{
                      marginTop: 8,
                      padding: "10px 12px",
                      overflowX: "auto",
                      fontSize: 11.5,
                      lineHeight: 1.5,
                      background: "var(--gray-100)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--r)"
                    }}
                  >
                    {JSON.stringify(tick, null, 2)}
                  </pre>
                </details>
              </div>
            )}
          </section>

          <section className="grid-two" style={{ marginTop: 18 }}>
            <div className="panel">
              <div className="panel-header">
                <h2>Recently rejected at triage</h2>
              </div>
              <div className="panel-body">
                <TriageTable posts={data?.triageRejected ?? []} />
              </div>
            </div>
            <div className="panel">
              <div className="panel-header">
                <h2>Recently accepted at triage</h2>
              </div>
              <div className="panel-body">
                <TriageTable posts={data?.triageAccepted ?? []} />
              </div>
            </div>
          </section>

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-header">
              <h2>Recent failures</h2>
            </div>
            <div className="panel-body">
              <div className="table-wrap">
                <table className="claims-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Kind</th>
                      <th>When</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.failed ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={4} className="empty-state">
                          Nothing has failed.
                        </td>
                      </tr>
                    ) : (
                      (data?.failed ?? []).map((post) => (
                        <tr key={post.id}>
                          <td>
                            {post.url ? (
                              <a
                                href={post.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover-text"
                                title={post.title ?? undefined}
                              >
                                {truncate(post.title, 70)}
                              </a>
                            ) : (
                              <span title={post.title ?? undefined}>{truncate(post.title, 70)}</span>
                            )}
                          </td>
                          <td>{humanise(post.kind) || "—"}</td>
                          <td>{when(post.processedAt ?? post.fetchedAt)}</td>
                          <td>
                            <code style={{ fontSize: 12 }} title={post.error ?? undefined}>
                              {truncate(post.error, 160)}
                            </code>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-header">
              <h2>Recent searches</h2>
            </div>
            <div className="panel-body">
              <div className="table-wrap">
                <table className="claims-table">
                  <thead>
                    <tr>
                      <th>Need</th>
                      <th>Filters</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.searches ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={3} className="empty-state">
                          Nobody has searched yet.
                        </td>
                      </tr>
                    ) : (
                      (data?.searches ?? []).map((search) => (
                        <tr key={search.id}>
                          <td title={search.needText ?? undefined}>
                            {truncate(search.needText, 140)}
                          </td>
                          <td>{filterSummary(search.filters)}</td>
                          <td>{when(search.createdAt)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      )}
    </>
  );
}
