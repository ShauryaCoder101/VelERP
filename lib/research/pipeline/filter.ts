/* Cheap pre-extraction gate.

   Extraction costs a Gemini call per post, so obviously worthless posts are
   dropped before they get there. Everything here is heuristic and deliberately
   generous: when in doubt, let the post through and let the extractor return an
   empty list. */

import { pipelineConfig } from "../config";

export type FilterablePost = {
  kind: string;
  title: string | null;
  body: string | null;
  comments: unknown;
  engagement: unknown;
};

/** Titles that start with one of these are never about an event idea. */
const JUNK_TITLE_PREFIXES = ["[hiring]", "[for hire]"];
/** Minimum view count a YouTube video needs, when the view count is known. */
const MIN_YOUTUBE_VIEWS = 500;

const URL_ONLY_RE = /^\s*(?:<?https?:\/\/\S+>?\s*)+$/i;

/** Normalise the comments JSONB blob into a list of strings.

    Sources store plain strings, but a dict with a body/text key is tolerated so
    a future source shape does not silently read as empty. */
export function commentTexts(comments: unknown): string[] {
  if (!comments) return [];
  if (typeof comments === "string") return [comments];
  if (!Array.isArray(comments)) return [];
  const out: string[] = [];
  for (const item of comments) {
    if (typeof item === "string") out.push(item);
    else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const value = record.body ?? record.text ?? record.comment;
      if (typeof value === "string") out.push(value);
    }
  }
  return out;
}

/** Title + body + comments: the same material the extractor will see. */
export function combinedText(post: FilterablePost): string {
  return [post.title ?? "", post.body ?? "", ...commentTexts(post.comments)]
    .filter(Boolean)
    .join("\n")
    .trim();
}

const engagementObject = (post: FilterablePost): Record<string, unknown> =>
  post.engagement && typeof post.engagement === "object" && !Array.isArray(post.engagement)
    ? (post.engagement as Record<string, unknown>)
    : {};

function engagementNumber(post: FilterablePost, key: string): number | null {
  const value = engagementObject(post)[key];
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : null;
}

export const isUrlOnly = (text: string | null | undefined): boolean =>
  !!text && URL_ONLY_RE.test(text);

/** Decide whether a post is worth an extraction call.

    Returns [true, reason] to process, [false, reason] to skip. The reason is
    stored on the post so a skip is always explainable. */
export function shouldProcess(post: FilterablePost): [boolean, string] {
  const config = pipelineConfig();

  /* Staff clips are curated by hand; they always go through. */
  if (post.kind === "clip") return [true, "clip: always processed"];

  const title = (post.title ?? "").trim().toLowerCase();
  for (const prefix of JUNK_TITLE_PREFIXES) {
    if (title.startsWith(prefix)) return [false, `junk title prefix '${prefix}'`];
  }

  const body = (post.body ?? "").trim();
  if (isUrlOnly(body) && !commentTexts(post.comments).length) {
    return [false, "body is only a link"];
  }

  const text = combinedText(post);
  if (text.length < config.minPostChars) {
    return [false, `too short: ${text.length} < ${config.minPostChars} chars`];
  }

  if (post.kind === "reddit") {
    const score = engagementNumber(post, "score");
    if (score === null) {
      /* Feed mode reads the public Atom feeds, which carry no score at all.
         Appearing in hot / top-of-week is the engagement signal, so the score
         gate does not apply; length still does. */
      if (engagementObject(post).via === "rss") {
        return [true, `reddit via rss feed (no score), ${text.length} chars`];
      }
      return [false, "reddit post has no score"];
    }
    if (score < config.minPostScore) {
      return [false, `reddit score ${score} < ${config.minPostScore}`];
    }
    return [true, `reddit score ${score}, ${text.length} chars`];
  }

  if (post.kind === "youtube") {
    const views = engagementNumber(post, "views");
    if (views !== null && views < MIN_YOUTUBE_VIEWS) {
      return [false, `youtube views ${views} < ${MIN_YOUTUBE_VIEWS}`];
    }
    return [true, `youtube ${views === null ? "views unknown" : `${views} views`}, ${text.length} chars`];
  }

  /* rss, web and anything new: length is the only gate. */
  return [true, `${post.kind}: ${text.length} chars`];
}
