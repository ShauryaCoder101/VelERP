/* Fetch one web page into a RawPostIn for the ordinary pipeline.

   Research mode is the only thing that creates kind="web" posts: a page found by
   a grounded Google search, fetched once, and then treated exactly like any
   other source post.

   Two rules keep the library clean:
     * Canonical identity. externalId is the URL stripped of tracking parameters
       and fragments, so the same article found through three different searches
       is one row, not three.
     * Denylist. Social platforms are excluded: their pages are login walls or
       JavaScript shells that yield no readable text, and Reddit in particular
       has its own (rate-limited, comment-aware) path into the pipeline. */

import { DEFAULT_PAGE_CHARS, fetchHtml, pageTitle, stripHtml, truncate } from "../html";
import type { RawPostIn } from "./types";

export const KIND = "web" as const;

const DENYLIST = [
  "reddit.com",
  "redd.it",
  "x.com",
  "twitter.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "pinterest.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com"
];

/** Suffixes that are never an article. The content-type check in fetchHtml
    catches the rest; this just saves the request. */
const BINARY_SUFFIXES = [
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".zip", ".rar",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".mp4", ".mp3", ".mov", ".avi"
];

/** Below this much readable text the fetch found a paywall, a cookie wall or a
    navigation shell rather than an article. */
const MIN_PAGE_CHARS = 400;

const TRACKING_KEYS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
  "ref_src"
]);

const FETCH_TIMEOUT = 15_000;

const isTracking = (key: string) => {
  const lowered = key.toLowerCase();
  return TRACKING_KEYS.has(lowered) || lowered.startsWith("utm_");
};

/** The stable identity of a page: scheme + host + path, tracking stripped. */
export function canonicalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parts: URL;
  try {
    parts = new URL(String(url).trim());
  } catch {
    return null;
  }
  const scheme = parts.protocol.replace(":", "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;
  const host = parts.hostname.toLowerCase();
  if (!host) return null;

  const defaultPort = (scheme === "http" && parts.port === "80") || (scheme === "https" && parts.port === "443");
  const authority = parts.port && !defaultPort ? `${host}:${parts.port}` : host;

  let path = parts.pathname || "/";
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";

  const kept = new URLSearchParams();
  for (const [key, value] of parts.searchParams) {
    if (!isTracking(key)) kept.append(key, value);
  }
  const query = kept.toString();
  return `${scheme}://${authority}${path}${query ? `?${query}` : ""}`;
}

export function hostOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}

/** True when the URL is on a platform research mode never fetches. */
export function isDenied(url: string): boolean {
  const host = hostOf(url);
  return DENYLIST.some((denied) => host === denied || host.endsWith(`.${denied}`));
}

/** Fetch one page as a RawPostIn, or null if it is not worth keeping.

    Null (with a reason logged) for: an unparseable or non-http URL, a
    denylisted platform, an obvious binary, a failed or non-HTML response, and a
    page with less than MIN_PAGE_CHARS of readable text. Never throws. */
export async function fetchPage(
  url: string,
  limit = DEFAULT_PAGE_CHARS
): Promise<RawPostIn | null> {
  const canonical = canonicalUrl(url);
  if (!canonical) return null;
  if (isDenied(canonical)) return null;
  const path = (() => {
    try {
      return new URL(canonical).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (BINARY_SUFFIXES.some((suffix) => path.endsWith(suffix))) return null;

  let html: string | null;
  try {
    html = await fetchHtml(canonical, FETCH_TIMEOUT);
  } catch (error) {
    console.warn("[research] fetching", canonical, "failed:", error);
    return null;
  }
  if (!html) return null;

  const body = truncate(stripHtml(html), limit);
  if (body.length < MIN_PAGE_CHARS) {
    console.info(`[research] skipping ${canonical}: only ${body.length} chars of text`);
    return null;
  }

  return {
    kind: KIND,
    externalId: canonical,
    url: canonical,
    title: pageTitle(html),
    body,
    comments: [],
    mediaUrls: [],
    /* No score, no votes: a web page carries no engagement signal at all, so
       the marker only records where it came from. */
    engagement: { via: "web", from: "research" },
    postedAt: null
  };
}
