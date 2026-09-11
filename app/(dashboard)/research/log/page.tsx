"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { humanise, when } from "../../../components/research/format";

/* The research log.

   One row per research job, newest first. The list refreshes itself every 15s
   while anything on it is still queued or running, and stops the moment the
   last job settles — a log of finished work has no reason to keep polling. */

const REFRESH_MS = 15000;
const NEED_MAX = 90;

/** Mirrors the stage labels the single-job route serves, so a running row reads
    the same here as it does inside the panel. Unknown stages fall back to a
    de-underscored version rather than showing a raw enum. */
const STAGE_LABELS: Record<string, string> = {
  expanding: "Working out what to search for",
  web: "Searching the web",
  reddit: "Searching Reddit",
  processing: "Pulling out ideas"
};

type JobRow = {
  id: string;
  needText: string | null;
  filters: Record<string, unknown> | null;
  status: string;
  stage: string | null;
  stats: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  searchId: string | null;
  posts: number | null;
  ideas: number | null;
};

type JobsResponse = { count: number; jobs: JobRow[] };

/** stats is free-form JSON from the worker; any counter may be absent. */
const counter = (stats: Record<string, unknown> | null | undefined, key: string): number => {
  const value = stats?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** "4 m 12 s" / "48 s" — how long the job actually took, once it is finished. */
const took = (startedAt: string | null, createdAt: string, finishedAt: string | null): string | null => {
  if (!finishedAt) return null;
  const start = Date.parse(startedAt ?? createdAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = Math.round((end - start) / 1000);
  const mins = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return mins ? `took ${mins} m ${rest} s` : `took ${rest} s`;
};

const isMoving = (job: JobRow) => job.status === "queued" || job.status === "running";

const SkeletonRows = () => (
  <div className="panel-body">
    {[1, 2, 3].map((i) => (
      <div key={i} className="skeleton-table-row">
        <span className="skeleton skeleton-cell skeleton-cell-wide" />
        <span className="skeleton skeleton-cell skeleton-cell-medium" />
        <span className="skeleton skeleton-cell skeleton-cell-medium" />
        <span className="skeleton skeleton-cell skeleton-cell-medium" />
        <span className="skeleton skeleton-cell skeleton-cell-medium" />
      </div>
    ))}
  </div>
);

function StateCell({ job }: { job: JobRow }) {
  if (job.status === "done") return <span className="status-pill active">Done</span>;
  if (job.status === "failed") return <span className="status-pill inactive">Failed</span>;

  const label =
    job.status === "queued"
      ? "Queued"
      : (job.stage && (STAGE_LABELS[job.stage] ?? humanise(job.stage))) || "Running";

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="phase-pill">{label}</span>
      <span className="rs-spinner" aria-hidden="true" />
    </span>
  );
}

export default function ResearchLogPage() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<JobRow[] | null> => {
    try {
      const response = await fetch("/api/research/jobs?limit=50");
      if (!response.ok) throw new Error(`The research log could not be read (${response.status})`);
      const payload = (await response.json()) as JobsResponse;
      return Array.isArray(payload?.jobs) ? payload.jobs : [];
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
      return null;
    }
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    const tick = async () => {
      const next = await load();
      if (!live) return;
      setLoading(false);
      if (!next) return;
      setError("");
      setJobs(next);
      /* Nothing is moving any more: stop asking. */
      if (!next.some(isMoving)) stop();
    };

    void tick();
    timer = setInterval(() => void tick(), REFRESH_MS);
    return () => {
      live = false;
      stop();
    };
  }, [load]);

  return (
    <>
      <section className="page-header">
        <h1>Research log</h1>
        <p>Every time the tool went outside the library: what it searched for and what it brought back.</p>
      </section>

      {error ? <p className="rs-error">{error}</p> : null}

      <section className="panel">
        {loading ? (
          <SkeletonRows />
        ) : (
          <div className="panel-body">
            <div className="table-wrap">
              <table className="claims-table">
                <thead>
                  <tr>
                    <th>Need</th>
                    <th>State</th>
                    <th>Pages / posts</th>
                    <th>New</th>
                    <th>Strengthened</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="empty-state">
                        No outside research yet. Tick &quot;Also research outside the library&quot; on a{" "}
                        <Link href="/research" className="hover-text">
                          search
                        </Link>{" "}
                        to start one.
                      </td>
                    </tr>
                  ) : (
                    jobs.map((job) => {
                      const need = (job.needText ?? "").trim();
                      const duration = took(job.startedAt, job.createdAt, job.finishedAt);
                      return (
                        <tr key={job.id}>
                          <td>
                            <Link
                              href={`/research/log/${job.id}`}
                              className="hover-text"
                              title={need || undefined}
                            >
                              <strong>{need ? truncate(need, NEED_MAX) : "(no need text)"}</strong>
                            </Link>
                            {job.status === "failed" && job.error ? (
                              <div className="cell-meta">{job.error}</div>
                            ) : null}
                          </td>
                          <td>
                            <StateCell job={job} />
                          </td>
                          <td>
                            {counter(job.stats, "pages_fetched")} pages · {job.posts ?? 0} sources
                          </td>
                          <td>{counter(job.stats, "ideas_created")}</td>
                          <td>{counter(job.stats, "ideas_merged")}</td>
                          <td>
                            {when(job.startedAt ?? job.createdAt)}
                            {duration ? <div className="cell-meta">{duration}</div> : null}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
