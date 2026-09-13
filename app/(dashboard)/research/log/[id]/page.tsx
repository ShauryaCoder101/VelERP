"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import ResearchPanel from "../../../../components/research/ResearchPanel";
import type { JobView } from "../../../../components/research/ResearchPanel";
import { dash, humanise, when } from "../../../../components/research/format";

/* One research job on its own page.

   The panel below does all the live work — it polls for itself and renders the
   progress, the counters and the ideas. This page only adds the things a panel
   embedded under a search form has no room for: the need text as a heading and
   the queries spelled out rather than hidden behind a <details>. */

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Filter values arrive as whatever the search form sent: strings, numbers,
    booleans, arrays. Anything that says nothing is dropped rather than shown. */
const filterLines = (filters: Record<string, unknown> | null | undefined): Array<[string, string]> =>
  Object.entries(asRecord(filters))
    .filter(([, value]) => {
      if (value === null || value === undefined || value === "") return false;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    })
    .map(([key, value]) => [humanise(key), dash(value)] as [string, string]);

export default function ResearchJobPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState("");

  /* Fetched once, only for the heading and the queries block. The panel keeps
     its own copy up to date; this one does not need to move. */
  useEffect(() => {
    if (!id) return;
    let live = true;
    (async () => {
      try {
        const response = await fetch(`/api/research/jobs/${id}`);
        if (!response.ok) throw new Error(`The research job could not be read (${response.status})`);
        const payload = (await response.json()) as JobView;
        if (live) setJob(payload);
      } catch (problem) {
        if (live) setError(problem instanceof Error ? problem.message : String(problem));
      }
    })();
    return () => {
      live = false;
    };
  }, [id]);

  const stats = asRecord(job?.stats);
  const queries = asRecord(stats.queries);
  const webQueries = asStrings(queries.web);
  const redditQueries = asStrings(queries.reddit);
  const notes = asStrings(stats.notes);
  const filters = filterLines(job?.filters);
  const need = (job?.needText ?? "").trim();
  const hasSearchedFor = webQueries.length > 0 || redditQueries.length > 0 || filters.length > 0 || notes.length > 0;

  return (
    <>
      <section className="page-header">
        <p style={{ marginBottom: 8 }}>
          <Link href="/research/log" className="hover-text">
            ← Research log
          </Link>
        </p>
        <h1>Research job</h1>
        <p>{need || "No need text was recorded for this job."}</p>
      </section>

      {error ? <p className="rs-error">{error}</p> : null}

      {/* The panel polls; this page fetched once. When the job settles under
          the panel, take its payload so the footer and the queries below stop
          describing a job that is no longer running. */}
      {id ? <ResearchPanel jobId={id} standalone onFinished={setJob} /> : null}

      {hasSearchedFor ? (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="panel-header">
            <h2>What it searched for</h2>
          </div>
          <div className="panel-body">
            {webQueries.length || redditQueries.length ? (
              <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
                {webQueries.map((query, index) => (
                  <li key={`web-${index}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="rs-chip">web</span> {query}
                  </li>
                ))}
                {redditQueries.map((query, index) => (
                  <li key={`reddit-${index}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="rs-chip">reddit</span> {query}
                  </li>
                ))}
              </ul>
            ) : null}

            {filters.length ? (
              <div className="rs-dl" style={{ marginTop: webQueries.length || redditQueries.length ? 16 : 0 }}>
                {filters.map(([label, value]) => (
                  <div key={label}>
                    <span className="rs-dt">{label}</span>
                    <span className="rs-dd">{value}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {notes.length ? (
              <ul className="rs-hint" style={{ listStyle: "none", marginTop: 16, display: "flex", flexDirection: "column", gap: 4 }}>
                {notes.map((note, index) => (
                  <li key={`note-${index}`}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ) : null}

      <p className="rs-hint" style={{ marginTop: 16 }}>
        Job {id ?? "—"} · {humanise(job?.status) || "—"} · created {when(job?.createdAt)}
      </p>
    </>
  );
}
