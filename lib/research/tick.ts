/* One cron tick: a bounded slice of the work the Python worker did continuously.

   There is no long-running process on Vercel, so /api/research/cron/tick runs
   every minute and does a little of everything inside ~50 seconds:

     a. poll at most RESEARCH_TICK_SOURCES due sources (RSS feeds, Reddit listings)
     b. backfill Reddit comments for at most one awaiting post
     c. process at most RESEARCH_TICK_POSTS `new` posts, stopping at the deadline
     d. advance the oldest research job by exactly one step

   Reddit is the constrained resource: at most RESEARCH_TICK_REDDIT_REQUESTS
   requests per tick (one by default), shared by (a), (b) and (d). Polling and
   the comment backfill therefore take turns on alternate minutes, and a
   subreddit poll reads one listing per turn (hot, then top-of-week). Reddit
   sees about one request a minute, which is what it tolerates from a shared
   IP - two a few seconds apart earns a 429. */

import { prisma } from "../db";
import { getGeminiConfig, tickConfig } from "./config";
import { stepOneJob } from "./jobs";
import { processPending, type Counts } from "./pipeline/process";
import {
  RedditBudget,
  backfillComments,
  pollViaFeeds,
  redditBackoffUntil,
  type BackfillCounts
} from "./sources/reddit";
import * as rss from "./sources/rss";
import { upsertRawPosts } from "./sources/upsert";

export type TickSummary = {
  ranAt: string;
  elapsedMs: number;
  polled: Array<{ source: string; fetched: number; inserted: number; updated: number }>;
  skippedSources: number;
  comments: BackfillCounts | null;
  redditBackoffUntil: string | null;
  redditRequestsLeft: number;
  processed: Counts;
  job: { jobId: string; phase: string; status: string } | null;
  geminiConfigured: boolean;
  notes: string[];
};

const isDue = (source: { lastPolledAt: Date | null; pollIntervalMin: number }, now: Date) => {
  if (!source.lastPolledAt) return true;
  const interval = Math.max(source.pollIntervalMin || 0, 1) * 60_000;
  return now.getTime() - source.lastPolledAt.getTime() >= interval;
};

/** A shorter tick than the cron's, for the "run a tick now" button on the admin
    screen: that route has a smaller maxDuration and a person is waiting on it.
    An override may only shrink the budget, never grow it. */
export type TickOverrides = { budgetMs?: number; processDeadlineMs?: number };

export async function runTick(overrides: TickOverrides = {}): Promise<TickSummary> {
  const started = Date.now();
  const config = tickConfig();
  const budgetMs = Math.min(overrides.budgetMs ?? config.budgetMs, config.budgetMs);
  const processDeadlineMs = Math.min(
    overrides.processDeadlineMs ?? config.processDeadlineMs,
    budgetMs
  );
  const deadline = started + budgetMs;
  const processDeadline = started + processDeadlineMs;
  const notes: string[] = [];

  const budget = new RedditBudget();
  const backoff = await redditBackoffUntil();
  if (backoff) {
    budget.blocked = true;
    notes.push(`reddit backing off until ${backoff.toISOString()}`);
  }

  const summary: TickSummary = {
    ranAt: new Date(started).toISOString(),
    elapsedMs: 0,
    polled: [],
    skippedSources: 0,
    comments: null,
    redditBackoffUntil: backoff ? backoff.toISOString() : null,
    redditRequestsLeft: budget.remaining,
    processed: {
      processed: 0,
      skipped: 0,
      triaged: 0,
      rejected: 0,
      awaiting_comments: 0,
      extracted: 0,
      ideas_created: 0,
      ideas_merged: 0,
      failed: 0
    },
    job: null,
    geminiConfigured: !!getGeminiConfig(),
    notes
  };

  /* Polling and the comment backfill both want the tick's single Reddit
     request. Alternating by the minute lets both keep moving. */
  const pollFirst = Math.floor(started / 60_000) % 2 === 0;

  const pollStep = async () => {
    const now = new Date();
    const sources = await prisma.researchSource.findMany({
      where: {
        enabled: true,
        kind: { in: ["reddit", "rss"] },
        OR: [{ backoffUntil: null }, { backoffUntil: { lt: now } }]
      },
      orderBy: [{ lastPolledAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: 40
    });

    let polled = 0;
    for (const source of sources) {
      if (polled >= config.maxSources) break;
      if (Date.now() > processDeadline) break;
      if (!isDue(source, now)) continue;

      /* One listing per poll, alternating hot / top-of-week. Two requests a few
         seconds apart earn a 429 from a shared IP, and a subreddit polled every
         two hours loses nothing by taking them in turn. */
      const settings = (source.settings ?? {}) as Record<string, unknown>;
      const listing = settings.last_listing === "hot" ? "top" : "hot";

      if (source.kind === "reddit" && !budget.available) {
        summary.skippedSources += 1;
        continue;
      }

      try {
        const posts =
          source.kind === "reddit"
            ? await pollViaFeeds(source, budget, [listing])
            : await rss.poll(source, { deadline: Math.min(deadline, processDeadline) });
        const { inserted, updated } = await upsertRawPosts(source.id, posts);
        await prisma.researchSource.update({
          where: { id: source.id },
          data: {
            lastPolledAt: new Date(),
            ...(source.kind === "reddit"
              ? { settings: { ...settings, last_listing: listing } as never }
              : {})
          }
        });
        summary.polled.push({
          source: `${source.kind}:${source.identifier}`,
          fetched: posts.length,
          inserted,
          updated
        });
        polled += 1;
      } catch (error) {
        console.error(`[research] polling failed for ${source.kind}:${source.identifier}`, error);
        notes.push(`poll failed: ${source.kind}:${source.identifier}`);
      }
    }
  };

  const backfillStep = async () => {
    if (!budget.available) return;
    try {
      summary.comments = await backfillComments(budget, config.maxCommentPosts);
    } catch (error) {
      console.error("[research] comment backfill failed", error);
      notes.push("comment backfill failed");
    }
  };

  if (pollFirst) {
    await pollStep();
    await backfillStep();
  } else {
    await backfillStep();
    await pollStep();
  }

  /* (c) the extraction backlog. Without a key, posts stay `new` and wait. */
  if (summary.geminiConfigured) {
    const [counts] = await processPending(config.maxPosts, processDeadline);
    summary.processed = counts;
  } else {
    notes.push("GEMINI_API_KEY is not set; holding pending posts");
  }

  /* (d) one step of the oldest research job. */
  if (summary.geminiConfigured && Date.now() < deadline) {
    try {
      summary.job = await stepOneJob(deadline, budget);
    } catch (error) {
      console.error("[research] research job step failed", error);
      notes.push("research job step failed");
    }
  }

  summary.redditRequestsLeft = budget.remaining;
  summary.elapsedMs = Date.now() - started;
  return summary;
}
