"use client";

import { useState } from "react";
import Link from "next/link";
import IdeaCard from "../../components/research/IdeaCard";
import ResearchPanel from "../../components/research/ResearchPanel";
import {
  BUDGET_BANDS,
  INTERACTION_MODES,
  PHYSICAL_INTENSITIES,
  SCOPE_CATEGORIES,
  SETTINGS,
  humanise,
  type Hit
} from "../../components/research/format";

/* The Research search screen.

   One plain-language box plus a drawer of filters that are all optional. The
   whole point of the library is that most fields are unknown, so this form
   sends only what the planner actually filled in — a blank field is dropped
   rather than sent as an empty value that could narrow anything. */

/* ── Types ── */

type SearchResponse = {
  searchId: string | null;
  jobId: string | null;
  answer: string | null;
  count: number;
  ideas: Hit[];
};

/** Everything the filter drawer holds, as strings — the form is the source of
    truth and is converted to the API's filter shape only on submit. */
type FilterForm = {
  scope_category: string;
  setting: string;
  interaction_mode: string;
  audience_size: string;
  minutes_per_participant_max: string;
  total_duration_max: string;
  budget_band: string;
  physical_intensity: string;
  brandable: string;
  event_types: string;
  formats: string;
  audience_types: string;
  tags: string;
  region: string;
};

const BLANK_FILTERS: FilterForm = {
  scope_category: "",
  setting: "",
  interaction_mode: "",
  audience_size: "",
  minutes_per_participant_max: "",
  total_duration_max: "",
  budget_band: "",
  physical_intensity: "",
  brandable: "",
  event_types: "",
  formats: "",
  audience_types: "",
  tags: "",
  region: ""
};

/** What a search was actually run with, kept so the research panel can re-run
    the identical search once the job has filled the library. */
type RanQuery = { needText: string; filters: Record<string, unknown> };

const PLACEHOLDER =
  "e.g. Something for 300 people at an indoor annual day in Mumbai that doesn't need a stage, " +
  "keeps queues short, and can carry the client's branding.";

/* ── Filter conversion ── */

const list = (value: string): string[] | null => {
  const cleaned = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return cleaned.length ? cleaned : null;
};

const num = (value: string): number | null => {
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

const text = (value: string): string | null => (value.trim() ? value.trim() : null);

/** Only the keys the planner filled in. Blank means "don't care" and is left
    out entirely rather than sent as "". */
function buildFilters(form: FilterForm): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    scope_category: text(form.scope_category),
    setting: text(form.setting),
    interaction_mode: text(form.interaction_mode),
    audience_size: num(form.audience_size),
    minutes_per_participant_max: num(form.minutes_per_participant_max),
    total_duration_max: num(form.total_duration_max),
    budget_band: text(form.budget_band),
    physical_intensity: text(form.physical_intensity),
    brandable: form.brandable === "" ? null : form.brandable === "true",
    event_types: list(form.event_types),
    formats: list(form.formats),
    audience_types: list(form.audience_types),
    tags: list(form.tags),
    region: text(form.region)
  };

  const filled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (value !== null) filled[key] = value;
  }
  return filled;
}

/* ── Brief ── */

const CITATION = /\[idea:([0-9a-fA-F-]{6,})\]/;

/* The answer model is not asked for markdown but writes it anyway, so bold
   markers are stripped rather than shown as literal asterisks. Bullets and
   paragraphs survive untouched: .rs-brief renders pre-wrap. */
const unbold = (text: string) => text.replace(/\*\*/g, "");

/** The answer model cites ideas as `[idea:<uuid>]`. Turn each one into a link
    labelled with the idea's title when that idea came back in these results,
    and with a stub of the id when it did not — the surrounding prose is left
    exactly as written, because .rs-brief renders pre-wrap. */
function renderBrief(answer: string, ideas: Hit[]) {
  const titles = new Map<string, string>();
  for (const hit of ideas) {
    if (hit.idea.title) titles.set(hit.idea.id, hit.idea.title);
  }

  /* split() with a capturing group alternates text, id, text, id, … */
  const parts = answer.split(new RegExp(CITATION.source, "g"));
  return parts.map((part, index) => {
    if (index % 2 === 0) return <span key={index}>{unbold(part)}</span>;
    const label = titles.get(part) ?? part.slice(0, 8);
    return (
      <Link key={index} href={`/research/ideas/${part}`}>
        [{label}]
      </Link>
    );
  });
}

/* ── Skeletons ── */

const SkeletonResults = () => (
  <section className="panel">
    <div className="panel-header">
      <div className="skeleton" style={{ width: 140, height: 18 }} />
    </div>
    <div className="panel-body">
      <ul className="rs-card-grid">
        {[1, 2, 3, 4].map((i) => (
          <li key={i} className="rs-card">
            <div className="skeleton skeleton-text medium" />
            <div className="skeleton skeleton-text long" />
            <div className="skeleton skeleton-text long" />
            <div className="skeleton skeleton-text short" />
          </li>
        ))}
      </ul>
    </div>
  </section>
);

/* ── Page ── */

export default function ResearchSearchPage() {
  const [needText, setNeedText] = useState("");
  const [synthesize, setSynthesize] = useState(true);
  const [k, setK] = useState(20);
  const [research, setResearch] = useState(false);
  const [filters, setFilters] = useState<FilterForm>(BLANK_FILTERS);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [ran, setRan] = useState<RanQuery | null>(null);

  const setFilter = (key: keyof FilterForm, value: string) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  const runSearch = async (query: RanQuery, withResearch: boolean) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/research/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          needText: query.needText,
          filters: query.filters,
          k,
          synthesize,
          research: withResearch
        })
      });
      if (!response.ok) {
        throw new Error(`The search could not be run (${response.status} ${response.statusText}).`);
      }
      const data = (await response.json()) as SearchResponse;
      setResult(data);
      setRan(query);
      /* A re-run never queues a second job, and must not drop the panel of the
         job that is still running. */
      if (withResearch) setJobId(data.jobId);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void runSearch({ needText, filters: buildFilters(filters) }, research);
  };

  const onRerun = () => {
    if (ran) void runSearch(ran, false);
  };

  const ideas = result?.ideas ?? [];
  const answer = result?.answer ?? "";

  return (
    <>
      <section className="page-header">
        <h1>Research</h1>
        <p>
          Describe what the client needs in plain language and the idea library comes back with the
          closest matches — no keywords, no field-by-field form filling.
        </p>
      </section>

      <section className="panel">
        <form onSubmit={onSubmit} autoComplete="off">
          <label className="auth-label" htmlFor="rs-need">
            What does the client need?
          </label>
          <textarea
            id="rs-need"
            className="input textarea rs-need"
            value={needText}
            onChange={(event) => setNeedText(event.target.value)}
            placeholder={PLACEHOLDER}
          />

          <div className="rs-search-row">
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "Searching…" : "Find ideas"}
            </button>

            <label className="rs-check">
              <input
                type="checkbox"
                checked={synthesize}
                onChange={(event) => setSynthesize(event.target.checked)}
              />
              Write a brief
            </label>

            <label className="rs-check" htmlFor="rs-k">
              Show
              <select
                id="rs-k"
                className="input select"
                value={String(k)}
                onChange={(event) => setK(Number(event.target.value))}
              >
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="50">50</option>
              </select>
            </label>
          </div>

          <div className="rs-search-row">
            <label className="rs-check">
              <input
                type="checkbox"
                checked={research}
                onChange={(event) => setResearch(event.target.checked)}
              />
              Also research outside the library (Reddit + web, about 5–10 minutes)
            </label>
          </div>
          <p className="rs-hint">
            This queues a job that reads the live web and Reddit for this brief. The library results
            come back immediately — the research panel appears above them and updates itself as the
            job works, so you can keep going.
          </p>

          <details className="rs-narrow">
            <summary>Narrow down (all optional)</summary>

            <p className="rs-hint">
              Every field here is optional — leave it blank and it will not narrow anything. An idea
              is only ever excluded by a field it actually carries, so ideas that never recorded the
              field still show up.
            </p>

            <div className="rs-filter-grid">
              <div>
                <label className="auth-label" htmlFor="f-scope">
                  Scope category
                </label>
                <select
                  id="f-scope"
                  className="input select"
                  value={filters.scope_category}
                  onChange={(event) => setFilter("scope_category", event.target.value)}
                >
                  <option value="">Any</option>
                  {SCOPE_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {humanise(value)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="auth-label" htmlFor="f-setting">
                  Setting
                </label>
                <select
                  id="f-setting"
                  className="input select"
                  value={filters.setting}
                  onChange={(event) => setFilter("setting", event.target.value)}
                >
                  <option value="">Any</option>
                  {SETTINGS.map((value) => (
                    <option key={value} value={value}>
                      {humanise(value)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="auth-label" htmlFor="f-interaction">
                  Interaction mode
                </label>
                <select
                  id="f-interaction"
                  className="input select"
                  value={filters.interaction_mode}
                  onChange={(event) => setFilter("interaction_mode", event.target.value)}
                >
                  <option value="">Any</option>
                  {INTERACTION_MODES.map((value) => (
                    <option key={value} value={value}>
                      {humanise(value)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="auth-label" htmlFor="f-audience">
                  Audience size
                </label>
                <input
                  id="f-audience"
                  className="input"
                  type="number"
                  min={1}
                  placeholder="e.g. 300"
                  value={filters.audience_size}
                  onChange={(event) => setFilter("audience_size", event.target.value)}
                />
              </div>

              <div>
                <label className="auth-label" htmlFor="f-per-person">
                  Minutes per participant (max)
                </label>
                <input
                  id="f-per-person"
                  className="input"
                  type="number"
                  min={0}
                  placeholder="e.g. 5"
                  value={filters.minutes_per_participant_max}
                  onChange={(event) => setFilter("minutes_per_participant_max", event.target.value)}
                />
              </div>

              <div>
                <label className="auth-label" htmlFor="f-duration">
                  Total duration (max, minutes)
                </label>
                <input
                  id="f-duration"
                  className="input"
                  type="number"
                  min={0}
                  step={5}
                  placeholder="e.g. 120"
                  value={filters.total_duration_max}
                  onChange={(event) => setFilter("total_duration_max", event.target.value)}
                />
              </div>

              <div>
                <label className="auth-label" htmlFor="f-budget">
                  Budget band
                </label>
                <select
                  id="f-budget"
                  className="input select"
                  value={filters.budget_band}
                  onChange={(event) => setFilter("budget_band", event.target.value)}
                >
                  <option value="">Any</option>
                  {BUDGET_BANDS.map((value) => (
                    <option key={value} value={value}>
                      {humanise(value)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="auth-label" htmlFor="f-intensity">
                  Physical intensity
                </label>
                <select
                  id="f-intensity"
                  className="input select"
                  value={filters.physical_intensity}
                  onChange={(event) => setFilter("physical_intensity", event.target.value)}
                >
                  <option value="">Any</option>
                  {PHYSICAL_INTENSITIES.map((value) => (
                    <option key={value} value={value}>
                      {humanise(value)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="auth-label" htmlFor="f-brandable">
                  Brandable
                </label>
                <select
                  id="f-brandable"
                  className="input select"
                  value={filters.brandable}
                  onChange={(event) => setFilter("brandable", event.target.value)}
                >
                  <option value="">Any</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>

              <div>
                <label className="auth-label" htmlFor="f-event-types">
                  Event types (comma separated)
                </label>
                <input
                  id="f-event-types"
                  className="input"
                  type="text"
                  placeholder="annual day, offsite, product launch"
                  value={filters.event_types}
                  onChange={(event) => setFilter("event_types", event.target.value)}
                />
              </div>

              <div>
                <label className="auth-label" htmlFor="f-formats">
                  Formats (comma separated)
                </label>
                <input
                  id="f-formats"
                  className="input"
                  type="text"
                  placeholder="game, installation, photo booth"
                  value={filters.formats}
                  onChange={(event) => setFilter("formats", event.target.value)}
                />
              </div>

              <div>
                <label className="auth-label" htmlFor="f-audience-types">
                  Audience types (comma separated)
                </label>
                <input
                  id="f-audience-types"
                  className="input"
                  type="text"
                  placeholder="employees, clients, families"
                  value={filters.audience_types}
                  onChange={(event) => setFilter("audience_types", event.target.value)}
                />
              </div>

              <div>
                <label className="auth-label" htmlFor="f-tags">
                  Tags (comma separated)
                </label>
                <input
                  id="f-tags"
                  className="input"
                  type="text"
                  placeholder="nostalgia, ai, team building"
                  value={filters.tags}
                  onChange={(event) => setFilter("tags", event.target.value)}
                />
              </div>

              <div>
                <label className="auth-label" htmlFor="f-region">
                  Region
                </label>
                <input
                  id="f-region"
                  className="input"
                  type="text"
                  placeholder="e.g. India"
                  value={filters.region}
                  onChange={(event) => setFilter("region", event.target.value)}
                />
              </div>
            </div>

            <p style={{ marginTop: 14 }}>
              <button
                type="button"
                className="link-button"
                onClick={() => setFilters(BLANK_FILTERS)}
              >
                Clear all filters
              </button>
            </p>
          </details>
        </form>
      </section>

      {error ? <p className="rs-error" style={{ marginTop: 16 }}>{error}</p> : null}

      {jobId ? (
        <section style={{ marginTop: 20 }}>
          <ResearchPanel jobId={jobId} onRerun={onRerun} />
        </section>
      ) : null}

      {loading && !result ? (
        <div style={{ marginTop: 20 }}>
          <SkeletonResults />
        </div>
      ) : null}

      {result && answer ? (
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="panel-header">
            <h2>Brief</h2>
          </div>
          <div className="panel-body">
            <div className="rs-brief">{renderBrief(answer, ideas)}</div>
          </div>
        </section>
      ) : null}

      {result ? (
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="panel-header">
            <h2>Results ({ideas.length})</h2>
          </div>
          <div className="panel-body">
            {ideas.length ? (
              <ul className="rs-card-grid">
                {ideas.map((hit) => (
                  <IdeaCard key={hit.idea.id} idea={hit.idea} hit={hit} source={hit.source} />
                ))}
              </ul>
            ) : (
              <div className="empty-state">
                Nothing in the library matched. Try fewer filters, or tick “Also research outside the
                library” and let it go and look.
              </div>
            )}
          </div>
        </section>
      ) : null}

      <p className="rs-hint" style={{ marginTop: 20 }}>
        or <Link href="/research/browse">browse everything</Link>
      </p>
      <p className="rs-hint" style={{ marginTop: 6 }}>
        <Link href="/research/clip">Add a clip</Link> · <Link href="/research/sources">Sources</Link>{" "}
        · <Link href="/research/log">Research log</Link> ·{" "}
        <Link href="/research/admin">Admin</Link>
      </p>
    </>
  );
}
