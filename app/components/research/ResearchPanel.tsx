"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import IdeaCard from "./IdeaCard";
import type { Hit } from "./format";

/* The progress panel for a research job.

   It polls GET /api/research/jobs/<id> every 8s while the job is queued or
   running and stops the moment it is done or failed — the Python version did
   this by swapping in a partial with no hx-trigger; here the interval simply
   clears itself.

   Shared by the search page (where library results sit underneath it and the
   panel can re-run the search) and the research log (where it stands alone). */

const POLL_MS = 8000;

/** Which counters are worth showing, in the order they happen. Anything zero or
    missing is left out rather than shown as a zero. */
const STAT_LABELS: Array<[string, string]> = [
  ["urls_found", "pages found"],
  ["pages_fetched", "pages read"],
  ["reddit_posts", "reddit posts"],
  ["posts_created", "new sources stored"],
  ["triaged", "triaged"],
  ["rejected", "rejected"],
  ["ideas_created", "new ideas"],
  ["ideas_merged", "ideas strengthened"]
];

export type JobView = {
  jobId: string;
  status: string;
  stage: string | null;
  stageLabel: string | null;
  needText: string;
  filters: Record<string, unknown> | null;
  stats: Record<string, unknown>;
  error: string | null;
  searchId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  ideas: Hit[];
  new_ideas: Hit[];
  strengthened_ideas: Hit[];
};

type Props = {
  jobId: string;
  /** On its own page there is no search form underneath to talk about or re-run. */
  standalone?: boolean;
  onRerun?: () => void;
  /** Fires once when the job reaches done/failed, so a page can react. */
  onFinished?: (job: JobView) => void;
};

export default function ResearchPanel({ jobId, standalone = false, onRerun, onFinished }: Props) {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState("");
  const [showStrengthened, setShowStrengthened] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/research/jobs/${jobId}`);
      if (!response.ok) throw new Error(`The research job could not be read (${response.status})`);
      return (await response.json()) as JobView;
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
      return null;
    }
  }, [jobId]);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      const next = await load();
      if (!live || !next) return;
      setError("");
      setJob(next);
      if (next.status === "done" || next.status === "failed") {
        if (timer) clearInterval(timer);
        timer = null;
        onFinished?.(next);
      }
    };

    void tick();
    timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
    /* onFinished is intentionally not a dependency: a parent that re-creates the
       callback each render would otherwise restart the poll every render. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  if (error && !job) {
    return (
      <section className="rs-panel failed">
        <h2 className="rs-panel-head">Research</h2>
        <p className="rs-panel-stage bad">{error}</p>
      </section>
    );
  }

  if (!job) {
    return (
      <section className="rs-panel">
        <h2 className="rs-panel-head">
          <span className="rs-spinner" aria-hidden="true" />
          Starting research
        </h2>
        <p className="rs-panel-stage muted">Queued — the next tick picks this up.</p>
      </section>
    );
  }

  const stats = (job.stats ?? {}) as Record<string, unknown>;
  const counters = STAT_LABELS.filter(([key]) => typeof stats[key] === "number" && (stats[key] as number) > 0);
  const queries = (stats.queries ?? { web: [], reddit: [] }) as { web?: string[]; reddit?: string[] };
  const webQueries = queries.web ?? [];
  const redditQueries = queries.reddit ?? [];
  const running = job.status === "queued" || job.status === "running";
  const newIdeas = job.new_ideas ?? [];
  const strengthened = job.strengthened_ideas ?? [];
  const total = newIdeas.length + strengthened.length;
  const awaiting = typeof stats.reddit_awaiting === "number" ? stats.reddit_awaiting : 0;

  return (
    <section className={`rs-panel ${job.status}`}>
      {running ? (
        <>
          <h2 className="rs-panel-head">
            <span className="rs-spinner" aria-hidden="true" />
            Researching outside the library
          </h2>
          <p className="rs-panel-stage">
            {job.status === "queued"
              ? "Queued — the next tick picks this up, usually within a minute."
              : `${job.stageLabel ?? "Working"}…`}{" "}
            <span className="muted">
              This usually takes 5–10 minutes.
              {standalone ? "" : " The results below are from the library and are ready to use now."}
            </span>
          </p>
        </>
      ) : job.status === "failed" ? (
        <>
          <h2 className="rs-panel-head">Research failed</h2>
          <p className="rs-panel-stage bad">{job.error || "No reason was recorded."}</p>
        </>
      ) : total === 0 ? (
        <>
          <h2 className="rs-panel-head">Research found nothing new</h2>
          <p className="rs-panel-stage">
            Everything it read was either off-topic or already in the library.
            {awaiting
              ? ` ${awaiting} reddit post(s) are waiting on their comments and may still produce something.`
              : ""}
          </p>
        </>
      ) : (
        <h2 className="rs-panel-head">
          Research finished — {total} idea{total === 1 ? "" : "s"} for this request
        </h2>
      )}

      {error ? <p className="rs-panel-stage bad">{error}</p> : null}

      {counters.length ? (
        <div className="rs-chips">
          {counters.map(([key, label]) => (
            <span className="rs-chip" key={key}>
              {String(stats[key])} {label}
            </span>
          ))}
        </div>
      ) : null}

      {webQueries.length || redditQueries.length ? (
        <details className="rs-queries">
          <summary>What it searched for</summary>
          <ul>
            {webQueries.map((query, index) => (
              <li key={`web-${index}`}>
                <span className="rs-chip">web</span> {query}
              </li>
            ))}
            {redditQueries.map((query, index) => (
              <li key={`reddit-${index}`}>
                <span className="rs-chip">reddit</span> {query}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {total > 0 ? (
        <>
          <section className="rs-panel-section">
            <h3 className="rs-panel-subhead">New ideas from this research ({newIdeas.length})</h3>
            {newIdeas.length ? (
              <ul className="rs-card-grid">
                {newIdeas.map((hit) => (
                  <IdeaCard key={hit.idea.id} idea={hit.idea} hit={hit} source={hit.source} badge="NEW" />
                ))}
              </ul>
            ) : (
              <p className="rs-hint">No brand-new ideas; everything it found was already in the library.</p>
            )}
          </section>

          {strengthened.length ? (
            <section className="rs-panel-section">
              <h3 className="rs-panel-subhead">
                Already in the library, strengthened by this research ({strengthened.length})
              </h3>
              {strengthened.length > 8 && !showStrengthened ? (
                <button type="button" className="btn-outline hover-text" onClick={() => setShowStrengthened(true)}>
                  Show {strengthened.length} strengthened ideas
                </button>
              ) : (
                <ul className="rs-card-grid">
                  {strengthened.map((hit) => (
                    <IdeaCard key={hit.idea.id} idea={hit.idea} hit={hit} source={hit.source} />
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {!standalone && onRerun ? (
            <p className="rs-panel-section">
              <button type="button" className="btn-outline hover-text" onClick={onRerun}>
                Search again including these
              </button>{" "}
              <span className="rs-hint">
                Re-runs your search over the library, which now holds what research found.
              </span>
            </p>
          ) : null}
        </>
      ) : null}

      {!running ? (
        <p className="rs-hint" style={{ marginTop: 14 }}>
          <Link href="/research/log" className="hover-text">
            Research log
          </Link>{" "}
          · job {job.jobId.slice(0, 8)}
        </p>
      ) : null}
    </section>
  );
}
