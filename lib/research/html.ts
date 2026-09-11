/* Minimal HTML -> readable text, with no parser dependency.

   Shared by the RSS poller, the clip intake and research mode's page fetcher so
   a fetched article, a pasted link and a grounded search hit are all cleaned the
   same way. Never throws: malformed markup degrades to whatever text survives. */

/** Content of these elements is never text we want. */
const DROP_CONTENT = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "head",
  "nav",
  "footer",
  "form",
  "iframe"
];

/** Elements that imply a line break around their text. */
const BLOCK =
  "address|article|aside|blockquote|br|div|dd|dl|dt|figcaption|figure|footer|h1|h2|h3|h4|h5|h6|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul";

const BLOCK_RE = new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, "gi");
const TAG_RE = /<[^>]*>/g;
const WS_RUN = /[ \t\r\f\v ​]+/g;
const BLANK_RUN = /\n{3,}/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  middot: "·",
  bull: "•",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  szlig: "ß",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  rupee: "₹"
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** The visible text of some HTML, whitespace-normalised. */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  let text = String(html);
  for (const tag of DROP_CONTENT) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi"), " ");
    /* An unclosed <script> / <style> would otherwise leak its source. */
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>`, "gi"), " ");
  }
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(BLOCK_RE, "\n");
  text = text.replace(TAG_RE, "");
  text = decodeEntities(text);

  const lines = text.split("\n").map((line) => line.replace(WS_RUN, " ").trim());
  return lines.join("\n").replace(BLANK_RUN, "\n\n").trim();
}

/** Trim text to `limit` characters, marking that it was cut. */
export function truncate(text: string | null | undefined, limit: number): string {
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}...`;
}

/** Sent on page fetches: a plain library UA is refused by a lot of publishers. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** Page body cap shared by every caller that turns a page into a raw post. */
export const DEFAULT_PAGE_CHARS = 12_000;

export type FetchResult = { ok: boolean; status: number; html: string | null };

/** Fetch a URL and decode it. `html` is null when there is nothing to read:
    a transport error, an HTTP error status, or a non-text content type. */
export async function fetchHtmlResult(url: string, timeoutMs = 10_000): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": BROWSER_USER_AGENT },
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, status: response.status, html: null };
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !["html", "text/", "xml"].some((t) => contentType.includes(t))) {
      return { ok: true, status: response.status, html: null };
    }
    return { ok: true, status: response.status, html: await response.text() };
  } catch (error) {
    console.warn("[research] could not fetch", url, error);
    return { ok: false, status: 0, html: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHtml(url: string, timeoutMs = 10_000): Promise<string | null> {
  return (await fetchHtmlResult(url, timeoutMs)).html;
}

/** Best-effort fetch of a URL as plain text. Returns "" on any failure. */
export async function fetchReadableText(
  url: string,
  limit = DEFAULT_PAGE_CHARS,
  timeoutMs = 10_000
): Promise<string> {
  return truncate(stripHtml(await fetchHtml(url, timeoutMs)), limit);
}

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const OG_TITLE_RE = /<meta[^>]+(?:property|name)=["']og:title["'][^>]*>/i;
/* Quote-aware on purpose: the Python original used content=["']([^"']*)["'],
   which stops at the first apostrophe and turns
   content="Etsy's First-Ever Festival Activation" into "Etsy". */
const CONTENT_RE = /content=(?:"([^"]*)"|'([^']*)')/i;

/** The page's own title: og:title first (the headline a publisher wants shown),
    then <title> (which usually carries a site-name suffix). */
export function pageTitle(html: string | null | undefined, limit = 300): string | null {
  if (!html) return null;
  const candidates: string[] = [];
  const meta = OG_TITLE_RE.exec(html);
  if (meta) {
    const content = CONTENT_RE.exec(meta[0]);
    if (content) candidates.push(content[1] ?? content[2] ?? "");
  }
  const tag = TITLE_RE.exec(html);
  if (tag) candidates.push(tag[1]);

  for (const candidate of candidates) {
    const cleaned = stripHtml(candidate).trim();
    if (cleaned) return cleaned.slice(0, limit);
  }
  return null;
}
