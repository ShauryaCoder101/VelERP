/* Research jobs: plan, search, fetch, and feed the pipeline - one step per tick.

   The Python worker ran a job start to finish in a single process over five to
   ten minutes. There is no such process here, so a job is a state machine whose
   cursor lives in ResearchJob.state and which advances by exactly one step per
   cron tick:

     expanding -> web search (one query per tick)
               -> web fetch  (a handful of pages per tick)
               -> reddit     (one query per tick)
               -> processing (a chunk of posts per tick)
               -> done

   Every step is wrapped on its own, so one dead URL or a Reddit 429 costs that
   step and nothing else. Budgets (RESEARCH_MAX_*) are hard: grounded search is
   metered and every fetched page costs a triage call, so a job can never decide
   to keep going.

   Exactly one tick may hold a job: claimJob takes it with FOR UPDATE SKIP
   LOCKED and stamps lockedAt; a lock older than RESEARCH_JOB_LOCK_MINUTES
   belonged to a tick that died mid-step and may be taken over. */

import type { Prisma, ResearchJob } from "@prisma/client";
import { prisma } from "../db";
import { researchBudgets, tickConfig } from "./config";
import * as gemini from "./gemini";
import { processPosts, type Counts } from "./pipeline/process";
import { RedditBudget, FeedBlocked, parseListingFeed, redditFetch, DEFAULT_LIMIT } from "./sources/reddit";
import { getOrCreateSource, upsertRawPosts } from "./sources/upsert";
import * as web from "./sources/web";
import type { RawPostIn } from "./sources/types";

const MAX_ERROR_CHARS = 2000;
/** A query shorter than this is too vague to be worth a search. */
const MIN_QUERY_CHARS = 8;
const MAX_QUERY_CHARS = 200;
/** Pages fetched in one tick during the web-fetch step. */
const FETCH_PER_TICK = 6;
/** Ticks the reddit step may spend waiting for a backoff to lift before it is
    skipped: a job should not sit behind Reddit for a quarter of an hour. */
const MAX_REDDIT_WAITS = 3;

/** The two source rows research mode files its posts under. Both are created
    disabled: they are not feeds, and the poller must never try to poll
    "r/search" or an interval-less web source. */
const WEB_SOURCE = ["web", "research", "Research mode (web pages)"] as const;
const REDDIT_SOURCE = ["reddit", "search", "Research mode (Reddit search)"] as const;

export type JobStats = {
  queries: { web: string[]; reddit: string[] };
  urls_found: number;
  pages_fetched: number;
  reddit_posts: number;
  posts_created: number;
  posts_linked: number;
  triaged: number;
  rejected: number;
  skipped: number;
  failed: number;
  reddit_awaiting: number;
  ideas_created: number;
  ideas_merged: number;
  ideas_linked: number;
  notes?: string[];
  cost_notes: {
    expansion_calls: number;
    grounded_searches: number;
    triage_calls: number;
    extraction_calls: number;
  };
};

export const blankStats = (): JobStats => ({
  queries: { web: [], reddit: [] },
  urls_found: 0,
  pages_fetched: 0,
  reddit_posts: 0,
  posts_created: 0,
  posts_linked: 0,
  triaged: 0,
  rejected: 0,
  skipped: 0,
  failed: 0,
  reddit_awaiting: 0,
  ideas_created: 0,
  ideas_merged: 0,
  ideas_linked: 0,
  cost_notes: {
    expansion_calls: 0,
    grounded_searches: 0,
    triage_calls: 0,
    extraction_calls: 0
  }
});

type Phase = "expanding" | "web_search" | "web_fetch" | "reddit" | "processing" | "done";

type JobState = {
  phase: Phase;
  webQueries: string[];
  redditQueries: string[];
  pendingUrls: string[];
  seenUrls: string[];
  postIds: string[];
  pendingPosts: string[];
  createdIdeas: string[];
  mergedIdeas: string[];
  redditWaits: number;
};

const blankState = (): JobState => ({
  phase: "expanding",
  webQueries: [],
  redditQueries: [],
  pendingUrls: [],
  seenUrls: [],
  postIds: [],
  pendingPosts: [],
  createdIdeas: [],
  mergedIdeas: [],
  redditWaits: 0
});

const readState = (job: ResearchJob): JobState => ({
  ...blankState(),
  ...((job.state as Partial<JobState> | null) ?? {})
});

const readStats = (job: ResearchJob): JobStats => ({
  ...blankStats(),
  ...((job.stats as Partial<JobStats> | null) ?? {})
});

/** The UI-facing stage for an internal phase. */
const stageOf = (phase: Phase): "expanding" | "web" | "reddit" | "processing" | null => {
  if (phase === "expanding") return "expanding";
  if (phase === "web_search" || phase === "web_fetch") return "web";
  if (phase === "reddit") return "reddit";
  if (phase === "processing") return "processing";
  return null;
};

/* ------------------------------------------------------------------------- */
/* Creating and claiming                                                      */
/* ------------------------------------------------------------------------- */

/** Queue a job. The tick picks it up; nothing runs in the caller's request. */
export async function createJob(input: {
  needText: string;
  filters?: Record<string, unknown> | null;
  searchId?: string | null;
  userId?: string | null;
}): Promise<ResearchJob> {
  return prisma.researchJob.create({
    data: {
      needText: (input.needText || "").trim() || null,
      filters: (input.filters && Object.keys(input.filters).length
        ? input.filters
        : undefined) as Prisma.InputJsonValue,
      searchId: input.searchId ?? null,
      userId: input.userId ?? null,
      status: "queued",
      stats: blankStats() as unknown as Prisma.InputJsonValue,
      state: blankState() as unknown as Prisma.InputJsonValue
    }
  });
}

/** Take the oldest job that needs a step, or null when there is none.

    FOR UPDATE SKIP LOCKED plus the lockedAt stamp in the same transaction means
    two overlapping ticks can race here safely: the loser skips the locked row,
    and once the winner commits the row is locked for the next few minutes. */
export async function claimJob(): Promise<ResearchJob | null> {
  const staleBefore = new Date(Date.now() - tickConfig().jobLockMinutes * 60_000);
  const now = new Date();

  const id = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ResearchJob"
      WHERE "status" = 'queued'
         OR ("status" = 'running' AND ("lockedAt" IS NULL OR "lockedAt" < ${staleBefore}))
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    if (!rows.length) return null;
    await tx.researchJob.update({
      where: { id: rows[0].id },
      data: { status: "running", lockedAt: now }
    });
    return rows[0].id;
  });

  if (!id) return null;
  const job = await prisma.researchJob.findUnique({ where: { id } });
  if (job && !job.startedAt) {
    return prisma.researchJob.update({ where: { id }, data: { startedAt: now } });
  }
  return job;
}

const save = async (
  jobId: string,
  state: JobState,
  stats: JobStats,
  extra: Prisma.ResearchJobUncheckedUpdateInput = {}
) => {
  await prisma.researchJob.update({
    where: { id: jobId },
    data: {
      stage: stageOf(state.phase),
      state: state as unknown as Prisma.InputJsonValue,
      stats: stats as unknown as Prisma.InputJsonValue,
      ...extra
    }
  });
};

/** Release the lock without changing anything else. */
export const releaseJob = (jobId: string) =>
  prisma.researchJob.update({ where: { id: jobId }, data: { lockedAt: null } });

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

/** Trim, drop blanks and near-duplicates, and apply the budget. */
function cleanQueries(queries: string[] | null | undefined, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of queries ?? []) {
    const query = String(raw).split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_QUERY_CHARS).trim();
    if (query.length < MIN_QUERY_CHARS) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(query);
    if (out.length >= limit) break;
  }
  return out;
}

/** Upsert posts and record them against the job.

    Posts we already had are linked too: the job genuinely surfaced them, even
    when they were processed long ago. */
async function linkPosts(
  jobId: string,
  sourceId: string,
  posts: RawPostIn[]
): Promise<{ ids: string[]; inserted: number }> {
  if (!posts.length) return { ids: [], inserted: 0 };
  const { ids, inserted } = await upsertRawPosts(sourceId, posts);
  if (ids.length) {
    await prisma.researchJobPost.createMany({
      data: ids.map((postId) => ({ jobId, postId })),
      skipDuplicates: true
    });
  }
  return { ids, inserted };
}

/* ------------------------------------------------------------------------- */
/* The steps                                                                  */
/* ------------------------------------------------------------------------- */

async function stepExpanding(job: ResearchJob, state: JobState, stats: JobStats) {
  const budgets = researchBudgets();
  const needText = job.needText ?? "";
  let plan = { web_queries: [] as string[], reddit_queries: [] as string[] };
  try {
    plan = await gemini.expandQueries(needText, job.filters);
    stats.cost_notes.expansion_calls += 1;
  } catch (error) {
    console.warn("[research] query expansion failed; falling back to the need text", error);
  }

  let web_queries = cleanQueries(plan.web_queries, budgets.maxWebQueries);
  let reddit_queries = cleanQueries(plan.reddit_queries, budgets.maxRedditQueries);

  if (!web_queries.length && needText.trim().length >= MIN_QUERY_CHARS) {
    web_queries = cleanQueries([needText], 1);
  }
  if (!reddit_queries.length && needText.trim().length >= MIN_QUERY_CHARS) {
    /* Reddit search does badly with long sentences; the first few words of the
       need are a poor query but a better one than the whole paragraph. */
    reddit_queries = cleanQueries([needText.split(/\s+/).slice(0, 6).join(" ")], 1);
  }

  state.webQueries = web_queries;
  state.redditQueries = reddit_queries;
  stats.queries = { web: web_queries, reddit: reddit_queries };
  state.phase = web_queries.length ? "web_search" : "reddit";
}

async function stepWebSearch(state: JobState, stats: JobStats) {
  const budgets = researchBudgets();
  const query = state.webQueries.shift();
  if (!query) {
    state.phase = state.pendingUrls.length ? "web_fetch" : "reddit";
    return;
  }

  /* The queries are deliberately different angles on the need, so the URL budget
     is shared between them: taking the first query's ten hits and then the
     second's would spend everything before the third angle is ever searched.
     Whatever a query leaves unused is still available to the next. */
  const planned = stats.queries.web.length || 1;
  const share = Math.max(1, Math.ceil(budgets.maxUrls / planned));
  const isLast = state.webQueries.length === 0;
  const ceiling = isLast
    ? budgets.maxUrls
    : Math.min(budgets.maxUrls, state.seenUrls.length + share);

  let hits: Array<{ url: string }> = [];
  try {
    hits = await gemini.webSearch(query);
    stats.cost_notes.grounded_searches += 1;
  } catch (error) {
    console.warn("[research] web search failed for", query, error);
  }

  for (const hit of hits) {
    if (state.seenUrls.length >= ceiling) break;
    const canonical = web.canonicalUrl(hit.url);
    if (!canonical || state.seenUrls.includes(canonical)) continue;
    state.seenUrls.push(canonical);
    state.pendingUrls.push(canonical);
  }
  stats.urls_found = state.seenUrls.length;
  if (!state.webQueries.length) state.phase = "web_fetch";
}

async function stepWebFetch(job: ResearchJob, state: JobState, stats: JobStats, deadline: number) {
  const source = await getOrCreateSource(WEB_SOURCE[0], WEB_SOURCE[1], WEB_SOURCE[2], {
    enabled: false,
    settings: { managed_by: "research" }
  });

  const fetched: RawPostIn[] = [];
  let budget = FETCH_PER_TICK;
  while (state.pendingUrls.length && budget > 0 && Date.now() < deadline) {
    const url = state.pendingUrls.shift()!;
    budget -= 1;
    try {
      const post = await web.fetchPage(url);
      if (post) fetched.push(post);
    } catch (error) {
      console.warn("[research] fetching", url, "failed", error);
    }
  }

  if (fetched.length) {
    const { ids, inserted } = await linkPosts(job.id, source.id, fetched);
    stats.pages_fetched += fetched.length;
    stats.posts_created += inserted;
    stats.posts_linked += ids.length;
    for (const id of ids) if (!state.postIds.includes(id)) state.postIds.push(id);
  }
  if (!state.pendingUrls.length) state.phase = "reddit";
}

async function stepReddit(job: ResearchJob, state: JobState, stats: JobStats, budget: RedditBudget) {
  if (!state.redditQueries.length) {
    state.phase = "processing";
    state.pendingPosts = [...state.postIds];
    return;
  }

  if (!budget.available) {
    state.redditWaits += 1;
    if (state.redditWaits >= MAX_REDDIT_WAITS) {
      (stats.notes ??= []).push("reddit search skipped: no request budget / backing off");
      state.redditQueries = [];
      state.phase = "processing";
      state.pendingPosts = [...state.postIds];
    }
    return;
  }

  const query = state.redditQueries.shift()!;
  const source = await getOrCreateSource(REDDIT_SOURCE[0], REDDIT_SOURCE[1], REDDIT_SOURCE[2], {
    enabled: false,
    settings: { managed_by: "research" }
  });

  try {
    const posts = await searchReddit(query, budget);
    const { ids, inserted } = await linkPosts(job.id, source.id, posts);
    stats.reddit_posts += posts.length;
    stats.posts_created += inserted;
    stats.posts_linked += ids.length;
    for (const id of ids) if (!state.postIds.includes(id)) state.postIds.push(id);
  } catch (error) {
    if (error instanceof FeedBlocked) {
      (stats.notes ??= []).push(`reddit refused '${query}': ${String(error.message)}`);
      state.redditQueries = [];
    } else {
      console.warn("[research] reddit search failed for", query, error);
    }
  }

  if (!state.redditQueries.length) {
    state.phase = "processing";
    state.pendingPosts = [...state.postIds];
  }
}

async function stepProcessing(job: ResearchJob, state: JobState, stats: JobStats, deadline: number) {
  const chunk = state.pendingPosts.splice(0, tickConfig().jobProcessChunk);
  if (chunk.length) {
    const [counts, ideas] = await processPosts(chunk, deadline);
    applyCounts(stats, counts);
    for (const id of ideas.created) if (!state.createdIdeas.includes(id)) state.createdIdeas.push(id);
    for (const id of ideas.merged) if (!state.mergedIdeas.includes(id)) state.mergedIdeas.push(id);
  }
  if (!state.pendingPosts.length) state.phase = "done";
}

const applyCounts = (stats: JobStats, counts: Counts) => {
  stats.triaged += counts.triaged;
  stats.rejected += counts.rejected;
  stats.skipped += counts.skipped;
  stats.failed += counts.failed;
  stats.reddit_awaiting += counts.awaiting_comments;
  stats.ideas_created += counts.ideas_created;
  stats.ideas_merged += counts.ideas_merged;
  stats.cost_notes.triage_calls += counts.triaged;
  stats.cost_notes.extraction_calls += counts.extracted;
};

/** Reddit's public search feed, as a research-mode source.

    https://www.reddit.com/search.rss?q=...&type=link returns an Atom listing in
    exactly the shape parseListingFeed already handles, so a search result enters
    the pipeline as an ordinary reddit feed post: body-only triage first, then
    the paced comment backfill, then triage again with the thread. `type=link`
    matters - without it Reddit answers with communities rather than posts. */
const TIME_WINDOW = "year";
const SEARCH_LIMIT = 25;

export function searchUrl(query: string, limit = SEARCH_LIMIT): string {
  const capped = Math.max(1, Math.min(Math.trunc(limit), 100));
  return (
    "https://www.reddit.com/search.rss?q=" +
    encodeURIComponent(query.trim()) +
    `&type=link&sort=relevance&t=${TIME_WINDOW}&limit=${capped}`
  );
}

/** Words too common to say anything about what a post is about. */
const STOPWORDS = new Set(
  `a an and are as at be best but by for from has have how i idea ideas in is it its
   like my of on or our that the their there they this to top up us was we what when
   where which who why with you your`.split(/\s+/)
);
const WORD_RE = /[a-z0-9]+/g;

/** Crudest possible stem: drop a trailing plural s. Enough to stop "events"
    missing a post titled "event", which is the only mismatch that shows up. */
const stem = (word: string) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);

const termsOf = (query: string): string[] => {
  const seen: string[] = [];
  for (const word of query.toLowerCase().match(WORD_RE) ?? []) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    const stemmed = stem(word);
    if (!seen.includes(stemmed)) seen.push(stemmed);
  }
  return seen;
};

const stemsOf = (text: string | null | undefined): Set<string> =>
  new Set((String(text ?? "").toLowerCase().match(WORD_RE) ?? []).map(stem));

/** Whether a search result is plausibly about what was searched for.

    Reddit's relevance ranking over a whole year is close to a bag-of-words OR: a
    real run of "crowd engagement ideas large events" came back with a Waffle
    House wedding story and four GTA VI threads, none of which share a single
    word with the query in their titles. Every one of those would cost a triage
    call to throw away, so they are dropped here, one step earlier.

    The rule reads the query the way the person meant it - as an AND. A post
    stays if half its distinctive words are in the title (which is what Reddit
    should have been matching on), or if every one of them appears somewhere in
    the post at all. */
export function isRelevant(post: RawPostIn, terms: string[]): boolean {
  if (!terms.length) return true;
  const title = stemsOf(post.title);
  if ([...terms].filter((term) => title.has(term)).length * 2 >= terms.length) return true;
  const everything = new Set([...title, ...stemsOf(post.body)]);
  return terms.every((term) => everything.has(term));
}

export async function searchReddit(query: string, budget: RedditBudget): Promise<RawPostIn[]> {
  const trimmed = (query || "").trim();
  if (!trimmed) return [];
  const xml = await redditFetch(searchUrl(trimmed), budget);
  const listed = parseListingFeed(xml, Math.min(SEARCH_LIMIT, DEFAULT_LIMIT));
  const terms = termsOf(trimmed);
  const posts = listed.filter((post) => isRelevant(post, terms));
  if (posts.length !== listed.length) {
    console.info(
      `[research] reddit search '${trimmed}': dropped ${listed.length - posts.length} of ${listed.length} as off-query`
    );
  }
  for (const post of posts) {
    /* Same via: rss contract as a subreddit listing, so the body gate and the
       comment backfill treat these identically; `from` only records that a
       research job, rather than a poll, is why we have this row. */
    post.engagement = { via: "rss", from: "search" };
  }
  return posts;
}

/* ------------------------------------------------------------------------- */
/* Finishing                                                                  */
/* ------------------------------------------------------------------------- */

/** Link the job to every idea its posts fed, and mark it done.

    The ideas are read back from ResearchIdeaSource rather than taken only from
    what this job happened to extract. Two reasons: the ordinary backlog is
    entitled to pick up a post this job inserted while the job was still
    fetching, and a page we already held maps to ideas this research genuinely
    surfaced. `created` stays true only for ideas this job brought into the
    library, so the panel can say "3 new, 2 strengthened". */
async function finishJob(job: ResearchJob, state: JobState, stats: JobStats) {
  const fromPosts = state.postIds.length
    ? await prisma.researchIdeaSource.findMany({
        where: { postId: { in: state.postIds } },
        select: { ideaId: true }
      })
    : [];

  const created = new Set(state.createdIdeas);
  const linked = new Set<string>([
    ...state.createdIdeas,
    ...state.mergedIdeas,
    ...fromPosts.map((row) => row.ideaId)
  ]);

  if (linked.size) {
    await prisma.researchJobIdea.createMany({
      data: [...linked].map((ideaId) => ({ jobId: job.id, ideaId, created: created.has(ideaId) })),
      skipDuplicates: true
    });
  }
  stats.ideas_linked = linked.size;

  await save(job.id, state, stats, {
    status: "done",
    stage: null,
    finishedAt: new Date(),
    lockedAt: null
  });
}

/* ------------------------------------------------------------------------- */
/* One step                                                                   */
/* ------------------------------------------------------------------------- */

export type JobStepResult = {
  jobId: string;
  phase: Phase;
  status: string;
};

/** Advance the oldest outstanding job by one step. Returns null when there is
    nothing queued. Never throws: a failed step fails the job, not the tick. */
export async function stepOneJob(
  deadline: number,
  redditBudget: RedditBudget
): Promise<JobStepResult | null> {
  const job = await claimJob();
  if (!job) return null;

  const state = readState(job);
  const stats = readStats(job);

  try {
    switch (state.phase) {
      case "expanding":
        await stepExpanding(job, state, stats);
        break;
      case "web_search":
        await stepWebSearch(state, stats);
        break;
      case "web_fetch":
        await stepWebFetch(job, state, stats, deadline);
        break;
      case "reddit":
        await stepReddit(job, state, stats, redditBudget);
        break;
      case "processing":
        await stepProcessing(job, state, stats, deadline);
        break;
      default:
        state.phase = "done";
    }

    if (state.phase === "done") {
      await finishJob(job, state, stats);
      return { jobId: job.id, phase: state.phase, status: "done" };
    }
    await save(job.id, state, stats, { lockedAt: null });
    return { jobId: job.id, phase: state.phase, status: "running" };
  } catch (error) {
    console.error(`[research] job ${job.id} step failed:`, error);
    try {
      await prisma.researchJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          error: `${error instanceof Error ? error.name : "Error"}: ${String(error)}`.slice(
            0,
            MAX_ERROR_CHARS
          ),
          stats: stats as unknown as Prisma.InputJsonValue,
          state: state as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
          lockedAt: null
        }
      });
    } catch (inner) {
      console.error(`[research] could not record the failure of job ${job.id}:`, inner);
    }
    return { jobId: job.id, phase: state.phase, status: "failed" };
  }
}

/** Ideas this job created or merged into, newly created ones first. */
export async function jobIdeaIds(jobId: string): Promise<{ created: string[]; strengthened: string[] }> {
  const rows = await prisma.researchJobIdea.findMany({
    where: { jobId },
    select: { ideaId: true, created: true }
  });
  return {
    created: rows.filter((row) => row.created).map((row) => row.ideaId),
    strengthened: rows.filter((row) => !row.created).map((row) => row.ideaId)
  };
}
