/* RSS / Atom listener. `source.identifier` is the feed URL.

   Entry summaries are usually truncated teasers, so a short summary triggers a
   fetch of the article itself (best effort - a failed fetch just means a shorter
   body). Unlike the Python worker, which had all the time in the world, a tick
   has ~50 seconds for everything, so only the first few short entries of a poll
   get that second request; the rest keep their summary and are still triaged on
   it. The next poll of the same feed re-reads it and can fill the others in. */

import { stripHtml, truncate, fetchReadableText } from "../html";
import { parseFeedXml } from "./feed";
import type { RawPostIn } from "./types";

export const KIND = "rss" as const;

export const DEFAULT_LIMIT = 40;
const BODY_CHARS = 12_000;
/** Summaries shorter than this trigger an article fetch. */
const FULLTEXT_THRESHOLD = 500;
const FETCH_TIMEOUT = 10_000;
/** Article fetches one poll may spend. Zero by default: the pipeline hydrates a
    short body when it processes the post (pipeline/process.ts), which spends the
    same request on the posts a tick actually looks at rather than on all forty
    entries of a feed. Raise it only for a backfill run with time to spare. */
const DEFAULT_FULLTEXT_BUDGET = 0;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export type RssPollOptions = {
  limit?: number;
  fetchFullText?: boolean;
  fullTextBudget?: number;
  /** Absolute time after which no more article fetches are started. */
  deadline?: number;
};

export async function fetchFeed(url: string): Promise<{ status: number; body: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/xml, text/xml, */*"
      },
      signal: controller.signal
    });
    if (!response.ok) return { status: response.status, body: null };
    return { status: response.status, body: await response.text() };
  } catch (error) {
    console.warn("[research] could not fetch feed", url, error);
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse feed XML into RawPostIn rows, without any network access. */
export function parseFeed(xml: string, limit = DEFAULT_LIMIT): RawPostIn[] {
  const posts: RawPostIn[] = [];
  for (const entry of parseFeedXml(xml).slice(0, limit)) {
    const externalId = entry.id || entry.link;
    if (!externalId) continue;
    posts.push({
      kind: KIND,
      externalId: String(externalId),
      url: entry.link,
      author: entry.author,
      title: stripHtml(entry.title) || null,
      body: truncate(stripHtml(entry.contentHtml), BODY_CHARS) || null,
      comments: [],
      mediaUrls: entry.mediaUrls,
      engagement: {},
      postedAt: entry.publishedAt
    });
  }
  return posts;
}

/** Fetch and parse the feed at `source.identifier`. */
export async function poll(
  source: { identifier: string; settings?: unknown },
  options: RssPollOptions = {}
): Promise<RawPostIn[]> {
  const settings = (source.settings ?? {}) as Record<string, unknown>;
  const limit = Number(settings.limit ?? options.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
  const wantFullText = options.fetchFullText ?? (settings.fetch_full_text as boolean | undefined) ?? true;

  const feed = await fetchFeed(source.identifier);
  if (!feed.body) return [];

  const posts = parseFeed(feed.body, limit);
  if (!wantFullText) return posts;

  let budget = options.fullTextBudget ?? DEFAULT_FULLTEXT_BUDGET;
  for (const post of posts) {
    if (budget <= 0) break;
    if (options.deadline && Date.now() > options.deadline) break;
    if (!post.url || (post.body?.length ?? 0) >= FULLTEXT_THRESHOLD) continue;
    budget -= 1;
    const article = await fetchReadableText(post.url, BODY_CHARS, FETCH_TIMEOUT);
    if (article.length > (post.body?.length ?? 0)) post.body = article;
  }
  return posts;
}
