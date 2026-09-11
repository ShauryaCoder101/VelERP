"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import IdeaCard from "../../../components/research/IdeaCard";
import {
  SOURCE_KINDS,
  humanise,
  type Idea,
  type SourceLink
} from "../../../components/research/format";

/* Browse: the whole accepted library, without having to describe a need first.

   Search is for when staff know what they want; this is for when they don't.
   The filters are literal here (picking "outdoor" means outdoor) and every
   dropdown carries an explicit "not recorded" choice, because a field the
   sources never mentioned is a real, common state in this library.

   The filter state lives in the URL as well as in React so the detail page's
   "back to browse" link can restore the exact view. useSearchParams is
   deliberately not used - it forces a Suspense boundary on the whole page -
   so the querystring is read once on mount and written with replaceState. */

const UNKNOWN = "(unknown)";
const PAGE_DEBOUNCE_MS = 350;

type Facet = { value: string; count: number };

type BrowseItem = Idea & { source: SourceLink | null };

type BrowseResponse = {
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  sort: string;
  seed: string | null;
  items: BrowseItem[];
  facets: {
    category: Facet[];
    setting: Facet[];
    interaction_mode: Facet[];
  };
};

type Sort = "newest" | "most_seen" | "random";

type Filters = {
  q: string;
  category: string;
  setting: string;
  interactionMode: string;
  sourceKind: string;
  sort: Sort;
  seed: string;
  page: number;
};

const EMPTY: Filters = {
  q: "",
  category: "",
  setting: "",
  interactionMode: "",
  sourceKind: "",
  sort: "newest",
  seed: "",
  page: 1
};

const isSort = (value: string): value is Sort =>
  value === "newest" || value === "most_seen" || value === "random";

const newSeed = () => Math.random().toString(36).slice(2);

/** Filters → querystring. Defaults are left out so a clean browse has a clean URL. */
function toQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.category) params.set("category", filters.category);
  if (filters.setting) params.set("setting", filters.setting);
  if (filters.interactionMode) params.set("interaction_mode", filters.interactionMode);
  if (filters.sourceKind) params.set("source_kind", filters.sourceKind);
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  if (filters.sort === "random" && filters.seed) params.set("seed", filters.seed);
  if (filters.page > 1) params.set("page", String(filters.page));
  return params.toString();
}

function fromQuery(search: string): Filters {
  const params = new URLSearchParams(search);
  const sort = (params.get("sort") ?? "newest").trim();
  const page = Number(params.get("page") ?? 1);
  return {
    q: params.get("q") ?? "",
    category: params.get("category") ?? "",
    setting: params.get("setting") ?? "",
    interactionMode: params.get("interaction_mode") ?? "",
    sourceKind: params.get("source_kind") ?? "",
    sort: isSort(sort) ? sort : "newest",
    seed: params.get("seed") ?? "",
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1
  };
}

/** "(unknown)" is a filter value, not a category name, so it gets its own words. */
const optionLabel = (value: string) => (value === UNKNOWN ? "Not recorded" : humanise(value));

function Dropdown({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: Facet[];
  onChange: (next: string) => void;
}) {
  /* A value chosen before the facets narrowed could otherwise vanish from its
     own dropdown, which reads as the filter having been cleared. */
  const shown = options.some((option) => option.value === value) || !value
    ? options
    : [...options, { value, count: 0 }];

  return (
    <div>
      <span className="rs-dt">{label}</span>
      <select className="input" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">All</option>
        {shown.map((option) => (
          <option key={option.value} value={option.value}>
            {optionLabel(option.value)}
            {option.count > 0 ? ` (${option.count})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function BrowsePage() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [ready, setReady] = useState(false);
  const [find, setFind] = useState("");
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  /* Mount: the URL is the source of truth, so a back link restores the view. */
  useEffect(() => {
    const initial = fromQuery(window.location.search);
    setFilters(initial);
    setFind(initial.q);
    setReady(true);
  }, []);

  const query = useMemo(() => toQuery(filters), [filters]);

  useEffect(() => {
    if (!ready) return;
    const url = query ? `${window.location.pathname}?${query}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  }, [ready, query]);

  useEffect(() => {
    if (!ready) return;
    const ticket = ++request.current;
    setLoading(true);
    setError(null);
    fetch(`/api/research/ideas${query ? `?${query}` : ""}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`The library did not answer (${response.status}).`);
        return (await response.json()) as BrowseResponse;
      })
      .then((payload) => {
        if (ticket !== request.current) return;
        setData(payload);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (ticket !== request.current) return;
        setError(cause instanceof Error ? cause.message : "Could not load the idea library.");
        setLoading(false);
      });
  }, [ready, query]);

  /* Typing should not fire a request per keystroke. */
  useEffect(() => {
    if (!ready) return;
    if (find === filters.q) return;
    const timer = window.setTimeout(() => {
      setFilters((current) => ({ ...current, q: find, page: 1 }));
    }, PAGE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [ready, find, filters.q]);

  const set = useCallback((patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, page: 1, ...patch }));
  }, []);

  const chooseSort = useCallback((sort: Sort) => {
    /* Shuffle re-seeds every time it is pressed, so it actually shuffles. */
    setFilters((current) => ({
      ...current,
      sort,
      seed: sort === "random" ? newSeed() : "",
      page: 1
    }));
  }, []);

  const clear = useCallback(() => {
    setFind("");
    setFilters(EMPTY);
  }, []);

  const facets = data?.facets;
  const sourceOptions: Facet[] = useMemo(
    () => [...SOURCE_KINDS, UNKNOWN].map((value) => ({ value, count: 0 })),
    []
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const page = data?.page ?? filters.page;
  const pages = data?.pages ?? 1;
  const linkQuery = `?from=browse${query ? `&${query}` : ""}`;
  const filtered =
    !!filters.q ||
    !!filters.category ||
    !!filters.setting ||
    !!filters.interactionMode ||
    !!filters.sourceKind;

  const goTo = (next: number) => {
    setFilters((current) => ({ ...current, page: Math.max(1, next) }));
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Browse ideas</h1>
          <p>Every accepted idea in the library. No search needed.</p>
        </div>
      </section>

      <div className="rs-browse">
        <aside className="panel rs-browse-filters">
          <div className="panel-header">
            <h2>Filter</h2>
          </div>
          <div className="panel-body rs-filter-grid">
            <div>
              <span className="rs-dt">Find</span>
              <input
                className="input"
                type="search"
                value={find}
                placeholder="a word in the title or summary"
                onChange={(event) => setFind(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") set({ q: find });
                }}
                onBlur={() => set({ q: find })}
              />
            </div>

            <Dropdown
              label="Category"
              value={filters.category}
              options={facets?.category ?? []}
              onChange={(value) => set({ category: value })}
            />
            <Dropdown
              label="Setting"
              value={filters.setting}
              options={facets?.setting ?? []}
              onChange={(value) => set({ setting: value })}
            />
            <Dropdown
              label="Interaction"
              value={filters.interactionMode}
              options={facets?.interaction_mode ?? []}
              onChange={(value) => set({ interactionMode: value })}
            />
            <Dropdown
              label="Source kind"
              value={filters.sourceKind}
              options={sourceOptions}
              onChange={(value) => set({ sourceKind: value })}
            />

            <div>
              <span className="rs-dt">Order</span>
              <div className="rs-chips">
                <button
                  type="button"
                  className="link-button hover-text"
                  onClick={() => chooseSort("newest")}
                  style={filters.sort === "newest" ? { color: "var(--black)", fontWeight: 700 } : undefined}
                >
                  Newest
                </button>
                <button
                  type="button"
                  className="link-button hover-text"
                  onClick={() => chooseSort("most_seen")}
                  style={filters.sort === "most_seen" ? { color: "var(--black)", fontWeight: 700 } : undefined}
                >
                  Most seen
                </button>
                <button
                  type="button"
                  className="link-button hover-text"
                  onClick={() => chooseSort("random")}
                  style={filters.sort === "random" ? { color: "var(--black)", fontWeight: 700 } : undefined}
                  title="Re-shuffles every time you press it"
                >
                  Shuffle
                </button>
              </div>
            </div>

            <div>
              <button type="button" className="link-button hover-text" onClick={clear}>
                Clear filters
              </button>
            </div>
          </div>
        </aside>

        <div>
          {error ? <p className="rs-error">{error}</p> : null}

          <p className="muted">
            {loading && !data
              ? "Loading the library…"
              : `Showing ${items.length} of ${total}${filtered ? " matching" : ""}`}
          </p>

          {loading ? (
            <ul className="rs-card-grid" style={{ marginTop: 12 }}>
              {Array.from({ length: 6 }).map((_, index) => (
                <li key={index} className="rs-card">
                  <div className="skeleton skeleton-text medium" />
                  <div className="skeleton skeleton-text long" />
                  <div className="skeleton skeleton-text long" />
                  <div className="skeleton skeleton-text short" />
                </li>
              ))}
            </ul>
          ) : items.length ? (
            <ul className="rs-card-grid" style={{ marginTop: 12 }}>
              {items.map((item) => (
                <IdeaCard
                  key={item.id}
                  idea={item}
                  source={item.source}
                  categoryFirst
                  linkQuery={linkQuery}
                />
              ))}
            </ul>
          ) : (
            <div className="panel empty-state" style={{ marginTop: 12 }}>
              {filtered
                ? "No idea in the library matches these filters yet."
                : "The library is empty — nothing has been accepted yet."}
            </div>
          )}

          <div className="rs-pager">
            <button
              type="button"
              className="btn-outline hover-text"
              disabled={loading || page <= 1}
              onClick={() => goTo(page - 1)}
            >
              ← Prev
            </button>
            <span className="muted">
              Page {page} of {pages}
            </span>
            <button
              type="button"
              className="btn-outline hover-text"
              disabled={loading || page >= pages}
              onClick={() => goTo(page + 1)}
            >
              Next →
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
