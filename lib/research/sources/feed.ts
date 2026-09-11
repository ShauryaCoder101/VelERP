/* One feed parser for both RSS 2.0 and Atom, on fast-xml-parser.

   The Python implementation used feedparser, which normalises the two dialects
   into one entry shape. This does the same job for the handful of fields the
   pipeline actually reads: id, link, title, content, author, timestamps and
   media. Reddit's public Atom listings go through here too. */

import { XMLParser } from "fast-xml-parser";

export type FeedEntry = {
  id: string | null;
  link: string | null;
  title: string | null;
  /** Richest content block on the entry, still as HTML. */
  contentHtml: string;
  author: string | null;
  publishedAt: Date | null;
  mediaUrls: string[];
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  /* Entries and links repeat; forcing arrays would complicate every read, so
     asArray() below handles both shapes instead. */
  processEntities: true
});

const asArray = <T>(value: T | T[] | undefined | null): T[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const text = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const inner = record["#text"];
    if (typeof inner === "string") return inner.trim() || null;
  }
  return null;
};

const linkOf = (entry: Record<string, unknown>): string | null => {
  const links = asArray(entry.link as unknown);
  for (const link of links) {
    if (typeof link === "string" && link.trim()) return link.trim();
    if (link && typeof link === "object") {
      const record = link as Record<string, unknown>;
      const rel = record["@_rel"];
      const href = record["@_href"];
      if (typeof href === "string" && (!rel || rel === "alternate")) return href;
    }
  }
  /* Atom feeds sometimes only carry an enclosure-style link; fall back to any. */
  for (const link of links) {
    if (link && typeof link === "object") {
      const href = (link as Record<string, unknown>)["@_href"];
      if (typeof href === "string") return href;
    }
  }
  return null;
};

const contentOf = (entry: Record<string, unknown>): string => {
  const candidates: string[] = [];
  for (const key of ["content:encoded", "content", "summary", "description"]) {
    for (const block of asArray(entry[key] as unknown)) {
      const value = text(block);
      if (value) candidates.push(value);
    }
  }
  if (!candidates.length) return "";
  return candidates.reduce((longest, item) => (item.length > longest.length ? item : longest), "");
};

const dateOf = (entry: Record<string, unknown>): Date | null => {
  for (const key of ["published", "updated", "pubDate", "dc:date"]) {
    const raw = text(entry[key] as unknown);
    if (!raw) continue;
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
};

const authorOf = (entry: Record<string, unknown>): string | null => {
  const author = entry.author ?? entry["dc:creator"];
  if (typeof author === "string") return author.trim() || null;
  if (author && typeof author === "object") {
    const record = author as Record<string, unknown>;
    return text(record.name) ?? text(record["#text"]);
  }
  return null;
};

const mediaOf = (entry: Record<string, unknown>): string[] => {
  const urls: string[] = [];
  for (const key of ["media:content", "media:thumbnail", "enclosure"]) {
    for (const item of asArray(entry[key] as unknown)) {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const url = record["@_url"] ?? record["@_href"];
        if (typeof url === "string") urls.push(url);
      }
    }
  }
  return [...new Set(urls)];
};

/** Parse feed XML into normalised entries. Returns [] on unparseable input. */
export function parseFeedXml(xml: string): FeedEntry[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    console.warn("[research] feed did not parse:", error);
    return [];
  }

  const rss = parsed.rss as Record<string, unknown> | undefined;
  const channel = (rss?.channel ?? parsed.channel) as Record<string, unknown> | undefined;
  const feed = parsed.feed as Record<string, unknown> | undefined;

  const raw = channel
    ? asArray(channel.item as unknown)
    : feed
      ? asArray(feed.entry as unknown)
      : [];

  const entries: FeedEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const link = linkOf(entry);
    const id = text(entry.id) ?? text(entry.guid) ?? link;
    entries.push({
      id,
      link,
      title: text(entry.title),
      contentHtml: contentOf(entry),
      author: authorOf(entry),
      publishedAt: dateOf(entry),
      mediaUrls: mediaOf(entry)
    });
  }
  return entries;
}
