/* Reddit listener: public Atom feeds, no credentials, nothing logged in.

   `source.identifier` is a subreddit name (no `r/` prefix). Reddit serves
   /r/<sub>/hot/.rss, /r/<sub>/top/.rss?t=week and /r/<sub>/comments/<id>/.rss
   unauthenticated provided the request carries a descriptive User-Agent. Feeds
   carry no score, so engagement is recorded as {"via": "rss"} and the filter
   treats "it was in hot / top-of-week" as the engagement signal.

   Pacing is the whole difficulty here. The Python worker held a process-wide
   6-second limiter; a serverless tick cannot, because every invocation is a
   fresh process. Instead:

     * one tick may spend at most RESEARCH_TICK_REDDIT_REQUESTS requests
       (default 2), spaced RESEARCH_REDDIT_SPACING_MS apart. Ticks are a minute
       apart, so that is ~2 requests/minute against Reddit's 10/minute ceiling.
     * a 429 / 403 does NOT sleep. It stamps `backoffUntil` on every reddit
       source row, which is the only piece of state that outlives the process,
       and the next ticks skip Reddit entirely until it passes.

   A listing poll fetches listings only. Comments - where a reddit idea usually
   actually lives - are filled in afterwards by backfillComments, one post per
   tick, and only for posts the body gate marked in-domain. */

import { prisma } from "../../db";
import { tickConfig } from "../config";
import { stripHtml, truncate } from "../html";
import { parseFeedXml } from "./feed";
import type { RawPostIn } from "./types";

export const KIND = "reddit" as const;

export const MAX_AGE_DAYS = 30;
export const MAX_COMMENTS = 10;
const COMMENT_CHARS = 1500;
export const DEFAULT_LIMIT = 50;
const FEED_BODY_CHARS = 12_000;
const FEED_TIMEOUT = 20_000;

/** A post that has waited this long for its comments goes on without them. */
const AWAITING_MAX_HOURS = 96;
/** Replies keep arriving for about a day, so a comment-poor post gets one re-fetch. */
const REFRESH_AFTER_HOURS = 24;
/** ...but only while the post is still young enough to be gathering replies. */
const REFRESH_MAX_POST_AGE_DAYS = 5;
/** A post that already has this many comments learnt enough from the first fetch. */
const REFRESH_MIN_COMMENTS = 5;

/** Descriptive UA, exactly as the Python feed reader sent. */
export const FEED_USER_AGENT =
  "windows:net.velocityindia.velresearch:v0.1 (internal research feed reader)";

const IMAGE_SUFFIXES = [".jpg", ".jpeg", ".png", ".gif", ".gifv", ".webp"];
const POST_ID_RE = /\/comments\/([a-z0-9]+)/i;
const THING_ID_RE = /^(t\d)_([a-z0-9]+)$/i;
const IMG_SRC_RE = /<img[^>]+src=["']([^"']+)["']/gi;
const HREF_RE = /<a[^>]+href=["']([^"']+)["']/gi;

/** Reddit refused or rate-limited us; give up on reddit for now. */
export class FeedBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedBlocked";
  }
}

/* ------------------------------------------------------------------------- */
/* Per-tick request budget                                                    */
/* ------------------------------------------------------------------------- */

export class RedditBudget {
  remaining: number;
  blocked = false;
  private lastRequestAt = 0;
  private spacingMs: number;

  constructor(remaining?: number, spacingMs?: number) {
    const config = tickConfig();
    this.remaining = remaining ?? config.maxRedditRequests;
    this.spacingMs = spacingMs ?? config.redditSpacingMs;
  }

  get available() {
    return !this.blocked && this.remaining > 0;
  }

  async take(): Promise<void> {
    if (this.blocked) throw new FeedBlocked("reddit is backing off");
    if (this.remaining <= 0) throw new FeedBlocked("no reddit requests left this tick");
    const wait = this.lastRequestAt ? this.spacingMs - (Date.now() - this.lastRequestAt) : 0;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.remaining -= 1;
    this.lastRequestAt = Date.now();
  }
}

/** True while Reddit is still in the penalty box from an earlier 429 / 403. */
export async function redditBackoffUntil(): Promise<Date | null> {
  const row = await prisma.researchSource.findFirst({
    where: { kind: "reddit", backoffUntil: { gt: new Date() } },
    orderBy: { backoffUntil: "desc" },
    select: { backoffUntil: true }
  });
  return row?.backoffUntil ?? null;
}

/** Reddit throttles per client, not per subreddit, so a refusal parks them all. */
export async function setRedditBackoff(minutes?: number): Promise<Date> {
  const until = new Date(Date.now() + (minutes ?? tickConfig().redditBackoffMinutes) * 60_000);
  await prisma.researchSource.updateMany({
    where: { kind: "reddit" },
    data: { backoffUntil: until }
  });
  return until;
}

/* ------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* ------------------------------------------------------------------------- */

/** GET one reddit feed through the tick's budget.

    Throws FeedBlocked on 429 / 403 (after stamping the shared backoff), on any
    other HTTP error, and on a transport failure. There is no retry: a tick has
    no time to sleep through Reddit's Retry-After, and the next tick is a minute
    away in any case. */
export async function redditFetch(url: string, budget: RedditBudget): Promise<string> {
  await budget.take();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": FEED_USER_AGENT,
        Accept:
          "application/atom+xml, application/rss+xml, application/xml;q=0.9, */*;q=0.5"
      },
      signal: controller.signal
    });
    if (response.status === 429 || response.status === 403) {
      budget.blocked = true;
      const until = await setRedditBackoff();
      throw new FeedBlocked(`HTTP ${response.status}; backing off until ${until.toISOString()}`);
    }
    if (!response.ok) throw new FeedBlocked(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (error instanceof FeedBlocked) throw error;
    throw new FeedBlocked(`request failed: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** URL of the hot or top (past week) Atom feed for a subreddit. */
export function listingUrl(subreddit: string, listing: string, limit = DEFAULT_LIMIT): string {
  const capped = Math.max(1, Math.min(Math.trunc(limit), 100));
  const base = `https://www.reddit.com/r/${subreddit}/${listing}/.rss`;
  return listing === "top" ? `${base}?t=week&limit=${capped}` : `${base}?limit=${capped}`;
}

/** URL of one post's Atom comment feed. */
export function commentsUrl(subreddit: string, postId: string, limit = MAX_COMMENTS): string {
  return `https://www.reddit.com/r/${subreddit}/comments/${postId}/.rss?limit=${limit}&sort=top`;
}

/* ------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* ------------------------------------------------------------------------- */

/** The base-36 submission id PRAW would report, parsed from a permalink.

    Falls back to the Atom entry id (t3_<id>) so an entry with an odd link still
    gets the identity an API-mode poll would give it. */
export function postIdFromLink(
  link: string | null | undefined,
  entryId?: string | null
): string | null {
  for (const candidate of [link, entryId]) {
    if (!candidate) continue;
    const match = POST_ID_RE.exec(String(candidate));
    if (match) return match[1].toLowerCase();
  }
  if (entryId) {
    const match = THING_ID_RE.exec(String(entryId).trim());
    if (match) return match[2].toLowerCase();
  }
  return null;
}

const thingKind = (id: string | null): string | null => {
  const match = THING_ID_RE.exec(String(id ?? "").trim());
  return match ? match[1].toLowerCase() : null;
};

/** Image URLs mentioned in an entry's content HTML. */
function feedMedia(html: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(IMG_SRC_RE)) urls.push(match[1].replace(/&amp;/g, "&"));
  for (const match of html.matchAll(HREF_RE)) {
    const clean = match[1].replace(/&amp;/g, "&");
    if (IMAGE_SUFFIXES.some((suffix) => clean.split("?")[0].toLowerCase().endsWith(suffix))) {
      urls.push(clean);
    }
  }
  return [...new Set(urls.filter((url) => url.startsWith("http")))];
}

/** Feeds give the author as /u/name; store the bare username. */
const cleanAuthor = (author: string | null): string | null => {
  if (!author) return null;
  const cleaned = author.trim().replace(/^\/?u\//, "").trim();
  return cleaned || null;
};

/** Parse a subreddit (or search) Atom listing into RawPostIn rows.

    Comments come later, from backfillComments. */
export function parseListingFeed(
  xml: string,
  limit = DEFAULT_LIMIT,
  now: Date = new Date()
): RawPostIn[] {
  const cutoff = new Date(now.getTime() - MAX_AGE_DAYS * 86_400_000);
  const posts: RawPostIn[] = [];

  for (const entry of parseFeedXml(xml).slice(0, limit)) {
    const externalId = postIdFromLink(entry.link, entry.id);
    if (!externalId) continue;
    if (entry.publishedAt && entry.publishedAt < cutoff) continue;
    const html = entry.contentHtml;
    posts.push({
      kind: KIND,
      externalId,
      url: entry.link,
      author: cleanAuthor(entry.author),
      title: stripHtml(entry.title) || null,
      body: truncate(stripHtml(html), FEED_BODY_CHARS) || null,
      comments: [],
      mediaUrls: feedMedia(html),
      /* Feeds carry no score at all; "via" tells the filter that being in hot /
         top-of-week IS the engagement signal. */
      engagement: { via: "rss" },
      postedAt: entry.publishedAt
    });
  }
  return posts;
}

/** Comment texts from a post's Atom comment feed, best first.

    The feed is requested with sort=top and exposes no reply nesting, so we keep
    the first `limit` comment entries in the order Reddit returned them. The
    submission's own entry (t3_...) is dropped. */
export function parseCommentsFeed(xml: string, limit = MAX_COMMENTS): string[] {
  const bodies: string[] = [];
  for (const entry of parseFeedXml(xml)) {
    if (bodies.length >= limit) break;
    if (thingKind(entry.id) === "t3") continue;
    const text = stripHtml(entry.contentHtml).trim();
    if (!text || text === "[deleted]" || text === "[removed]") continue;
    bodies.push(text.slice(0, COMMENT_CHARS));
  }
  return bodies;
}

/* ------------------------------------------------------------------------- */
/* Polling                                                                    */
/* ------------------------------------------------------------------------- */

/** Feed mode: the hot and/or top-of-week Atom listings, and nothing else.

    Each listing costs one request from the tick's budget; when the budget runs
    out mid-poll the posts already listed are still returned. Pass `listings` to
    fetch only one of them - which is what the tick does, because Reddit answers
    429 to two unauthenticated feed requests a few seconds apart from a shared
    IP, and a subreddit polled every two hours loses nothing by taking hot this
    time and top-of-week the next. */
export async function pollViaFeeds(
  source: { identifier: string; settings?: unknown },
  budget: RedditBudget,
  listings: string[] = ["hot", "top"]
): Promise<RawPostIn[]> {
  const name = String(source.identifier).replace(/^r\//, "").replace(/\/+$/, "");
  const settings = (source.settings ?? {}) as Record<string, unknown>;
  const limit = Number(settings.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;

  const posts = new Map<string, RawPostIn>();
  for (const listing of listings) {
    if (!budget.available) break;
    let xml: string;
    try {
      xml = await redditFetch(listingUrl(name, listing, limit), budget);
    } catch (error) {
      console.warn(`[research] giving up on r/${name} ${listing} this tick:`, String(error));
      break;
    }
    for (const post of parseListingFeed(xml, limit)) {
      if (!posts.has(post.externalId)) posts.set(post.externalId, post);
    }
  }
  return [...posts.values()];
}

/* ------------------------------------------------------------------------- */
/* Paced comment backfill                                                     */
/* ------------------------------------------------------------------------- */

type PostRow = {
  id: string;
  externalId: string;
  url: string | null;
  comments: unknown;
  engagement: unknown;
  triage: unknown;
  status: string;
  source?: { identifier: string } | null;
};

/** The subreddit a stored post belongs to.

    Read from the permalink first (it is on the row itself and survives a source
    being renamed), falling back to the source's identifier. */
export function subredditOf(post: PostRow): string | null {
  const match = /\/r\/([A-Za-z0-9_]+)\//.exec(String(post.url ?? ""));
  if (match) return match[1];
  const identifier = post.source?.identifier;
  if (identifier) return String(identifier).replace(/^r\//, "").replace(/\/+$/, "") || null;
  return null;
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};

const commentCount = (value: unknown) => (Array.isArray(value) ? value.length : 0);

export type BackfillCounts = {
  fetched: number;
  promoted_stale: number;
  blocked: number;
  refreshed: number;
  requeued: number;
};

const blankCounts = (): BackfillCounts => ({
  fetched: 0,
  promoted_stale: 0,
  blocked: 0,
  refreshed: 0,
  requeued: 0
});

/** Fetch one post's comment feed and store it. Returns the comment count, or
    null when the subreddit could not be determined (nothing to fetch). */
async function fetchCommentsInto(
  post: PostRow,
  now: Date,
  budget: RedditBudget
): Promise<number | null> {
  const name = subredditOf(post);
  if (!name) return null;
  const xml = await redditFetch(commentsUrl(name, post.externalId), budget);
  const comments = parseCommentsFeed(xml, MAX_COMMENTS);
  const stored = commentCount(post.comments);
  const kept = comments.length >= stored ? comments : (post.comments as string[]);

  const engagement = asObject(post.engagement);
  engagement.via = "rss";
  engagement.comments = kept?.length ?? 0;
  engagement.comments_fetched_at = now.toISOString();

  await prisma.researchPost.update({
    where: { id: post.id },
    data: {
      comments: (kept?.length ? kept : undefined) as never,
      engagement: engagement as never
    }
  });
  post.comments = kept;
  post.engagement = engagement;
  return comments.length;
}

/** Spend up to `budget` rate-limited requests on reddit comment feeds.

    Three queues, backlog first:

    1. posts sitting in awaiting_comments (oldest first) - every one was put
       there by the body gate, so it is already known to be on-topic. Fetching
       their comments promotes them to `new` for a second triage on the whole
       thread.
    2. anything still waiting after AWAITING_MAX_HOURS is promoted anyway and
       stamped comments_skipped_at, so the body gate does not send it straight
       back. This costs no requests.
    3. a second look at young posts whose first fetch found barely any comments.
       If the re-fetch finds more and the post had been rejected as not_idea, it
       goes back to `new` to be re-triaged with what the thread now says. */
export async function backfillComments(
  budget: RedditBudget,
  maxPosts = 1
): Promise<BackfillCounts> {
  const counts = blankCounts();
  const now = new Date();
  let remaining = Math.min(maxPosts, budget.remaining);

  /* --- 1. the awaiting_comments backlog, oldest first ------------------- */
  if (remaining > 0 && budget.available) {
    const awaiting = await prisma.researchPost.findMany({
      where: { status: "awaiting_comments" },
      orderBy: [{ fetchedAt: "asc" }, { id: "asc" }],
      take: remaining,
      select: {
        id: true,
        externalId: true,
        url: true,
        comments: true,
        engagement: true,
        triage: true,
        status: true,
        source: { select: { identifier: true } }
      }
    });

    for (const post of awaiting) {
      if (remaining <= 0 || !budget.available) break;
      let found: number | null;
      try {
        found = await fetchCommentsInto(post, now, budget);
      } catch (error) {
        counts.blocked += 1;
        console.warn("[research] reddit blocked the comment backfill:", String(error));
        return counts;
      }
      remaining -= 1;
      const data: Record<string, unknown> = {
        status: "new",
        error: null,
        processedAt: null
      };
      if (found === null) {
        console.warn("[research] no subreddit for post", post.id, "- promoting without comments");
        const engagement = asObject(post.engagement);
        engagement.via = engagement.via ?? "rss";
        engagement.comments_skipped_at = now.toISOString();
        data.engagement = engagement;
      }
      await prisma.researchPost.update({ where: { id: post.id }, data: data as never });
      counts.fetched += 1;
    }
  }

  /* --- 2. anything that has waited too long goes on without comments ----- */
  const staleCutoff = new Date(now.getTime() - AWAITING_MAX_HOURS * 3_600_000);
  const stale = await prisma.researchPost.findMany({
    where: { status: "awaiting_comments", fetchedAt: { lt: staleCutoff } },
    select: { id: true, engagement: true },
    take: 25
  });
  for (const post of stale) {
    const engagement = asObject(post.engagement);
    engagement.via = engagement.via ?? "rss";
    engagement.comments_skipped_at = now.toISOString();
    await prisma.researchPost.update({
      where: { id: post.id },
      data: { status: "new", error: null, processedAt: null, engagement: engagement as never }
    });
    counts.promoted_stale += 1;
  }

  /* --- 3. second look at young, comment-poor posts ----------------------- */
  if (remaining <= 0 || !budget.available) return counts;
  const refreshCutoff = new Date(now.getTime() - REFRESH_AFTER_HOURS * 3_600_000).toISOString();
  const youngCutoff = new Date(now.getTime() - REFRESH_MAX_POST_AGE_DAYS * 86_400_000);

  const candidateIds = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ResearchPost"
    WHERE "kind" = 'reddit'
      AND "status" NOT IN ('extracted', 'awaiting_comments')
      AND "engagement" ->> 'via' = 'rss'
      AND "engagement" ->> 'comments_fetched_at' < ${refreshCutoff}
      AND "engagement" ->> 'comments_refreshed_at' IS NULL
      AND "postedAt" IS NOT NULL
      AND "postedAt" > ${youngCutoff}
      AND COALESCE(
            CASE WHEN jsonb_typeof("comments") = 'array'
                 THEN jsonb_array_length("comments") ELSE 0 END, 0) < ${REFRESH_MIN_COMMENTS}
    ORDER BY "postedAt" DESC
    LIMIT ${remaining}
  `;

  for (const { id } of candidateIds) {
    if (remaining <= 0 || !budget.available) break;
    const post = await prisma.researchPost.findUnique({
      where: { id },
      select: {
        id: true,
        externalId: true,
        url: true,
        comments: true,
        engagement: true,
        triage: true,
        status: true,
        source: { select: { identifier: true } }
      }
    });
    if (!post) continue;

    const before = commentCount(post.comments);
    let found: number | null;
    try {
      found = await fetchCommentsInto(post, now, budget);
    } catch (error) {
      counts.blocked += 1;
      console.warn("[research] reddit blocked the comment refresh:", String(error));
      return counts;
    }
    remaining -= 1;

    const engagement = asObject(post.engagement);
    engagement.comments_refreshed_at = now.toISOString();
    const verdict = asObject(post.triage).verdict;
    const requeue = (found ?? 0) > before && post.status === "rejected" && verdict === "not_idea";
    await prisma.researchPost.update({
      where: { id: post.id },
      data: {
        engagement: engagement as never,
        ...(requeue ? { status: "new", error: null, processedAt: null } : {})
      } as never
    });
    counts.refreshed += 1;
    if (requeue) counts.requeued += 1;
  }

  return counts;
}
