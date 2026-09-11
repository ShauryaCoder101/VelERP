/* The only module that talks to Gemini.

   Plain fetch against the REST API (generativelanguage.googleapis.com/v1beta),
   verified live on 2026-09-12:
     * structured output  -> models/{model}:generateContent with
       generationConfig.responseMimeType + responseSchema
     * embeddings         -> models/{model}:batchEmbedContents with
       taskType + outputDimensionality
     * grounded search    -> tools: [{ google_search: {} }]

   What the docs do not spell out, and what this code is shaped by:
     * grounding chunks never carry the real page. Every citation is a
       vertexaisearch.cloud.google.com/grounding-api-redirect/... link that has
       to be resolved over HTTP.
     * chunk titles are the bare domain ("vfairs.com"), so a readable page title
       has to come from the model's own prose, which cites the same redirect
       URLs as markdown links. */

import { getGeminiConfig } from "./config";
import {
  ANSWER_SYSTEM_PROMPT,
  EXTRACTION_RESPONSE_SCHEMA,
  EXTRACT_SYSTEM_PROMPT,
  RESEARCH_PLAN_RESPONSE_SCHEMA,
  RESEARCH_PLAN_SYSTEM_PROMPT,
  TRIAGE_RESPONSE_SCHEMA,
  TRIAGE_SYSTEM_PROMPT,
  WEB_SEARCH_PROMPT,
  type IdeaExtraction,
  type ResearchPlan,
  type TriageResult,
  type WebHit
} from "./schema";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export type TaskType =
  | "RETRIEVAL_DOCUMENT"
  | "RETRIEVAL_QUERY"
  | "SEMANTIC_SIMILARITY"
  | "CLASSIFICATION"
  | "CLUSTERING"
  | "QUESTION_ANSWERING"
  | "FACT_VERIFICATION";

/** Rough input budget for one extraction call, in whitespace-separated words. */
export const MAX_INPUT_WORDS = 6000;
/** Triage only has to recognise the shape of a post, so it gets a smaller slice. */
export const MAX_TRIAGE_WORDS = 2500;
/** The embeddings endpoint accepts a bounded batch per request. */
const EMBED_BATCH_SIZE = 100;
/** How many resolved pages one webSearch call may return. */
const MAX_WEB_HITS = 10;
const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export class GeminiNotConfigured extends Error {
  constructor() {
    super("GEMINI_API_KEY is not set");
    this.name = "GeminiNotConfigured";
  }
}

const requireConfig = () => {
  const config = getGeminiConfig();
  if (!config) throw new GeminiNotConfigured();
  return config;
};

/* ------------------------------------------------------------------------- */
/* Transport: one POST, with retry on 429 / 5xx                               */
/* ------------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type PostOptions = { timeoutMs?: number; attempts?: number };

async function postJson(
  path: string,
  body: unknown,
  { timeoutMs = 25_000, attempts = 3 }: PostOptions = {}
): Promise<Record<string, unknown>> {
  const { apiKey } = requireConfig();
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(2_000 * 2 ** (attempt - 1), 8_000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${API_BASE}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (response.ok) return (await response.json()) as Record<string, unknown>;

      const text = (await response.text()).slice(0, 500);
      const retryable = response.status === 429 || response.status >= 500;
      lastError = new Error(`Gemini ${response.status}: ${text}`);
      if (!retryable) throw lastError;
    } catch (error) {
      /* A non-retryable HTTP error is rethrown above and must not be retried. */
      if (error instanceof Error && error.message.startsWith("Gemini ") && !isRetryable(error)) {
        throw error;
      }
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const isRetryable = (error: Error) => {
  const match = /^Gemini (\d{3})/.exec(error.message);
  if (!match) return true; // transport / abort: worth one more go
  const status = Number(match[1]);
  return status === 429 || status >= 500;
};

const responseText = (payload: Record<string, unknown>): string => {
  const candidates = (payload.candidates as Array<Record<string, unknown>> | undefined) ?? [];
  const parts =
    ((candidates[0]?.content as Record<string, unknown> | undefined)?.parts as
      | Array<{ text?: string }>
      | undefined) ?? [];
  return parts.map((part) => part.text ?? "").join("");
};

type GenerateOptions = {
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  responseSchema?: Record<string, unknown>;
  tools?: unknown[];
  timeoutMs?: number;
};

async function generate(options: GenerateOptions): Promise<Record<string, unknown>> {
  const generationConfig: Record<string, unknown> = {
    temperature: options.temperature ?? 0.2
  };
  if (options.responseSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = options.responseSchema;
  }
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: options.prompt }] }],
    generationConfig
  };
  if (options.system) body.systemInstruction = { parts: [{ text: options.system }] };
  if (options.tools) body.tools = options.tools;

  return postJson(`models/${options.model}:generateContent`, body, {
    timeoutMs: options.timeoutMs
  });
}

/* ------------------------------------------------------------------------- */
/* Prompt building                                                            */
/* ------------------------------------------------------------------------- */

/** Trim text to `budget` words. Returns the text and the words consumed. */
function truncateWords(text: string, budget: number): [string, number] {
  if (budget <= 0) return ["", 0];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= budget) return [text, words.length];
  return [`${words.slice(0, budget).join(" ")} [...truncated]`, budget];
}

/** Render a source post into the user turn of the extraction prompt.

    The title and body get first claim on the word budget; whatever is left goes
    to the comments, which are dropped one at a time from the end. Triage reuses
    this with a smaller budget. */
export function buildExtractPrompt(
  title: string | null | undefined,
  body: string | null | undefined,
  comments: string[] | null | undefined,
  url: string | null | undefined,
  kind: string | null | undefined,
  budget: number = MAX_INPUT_WORDS
): string {
  let remaining = budget;
  const parts: string[] = [`SOURCE KIND: ${kind || "unknown"}`, `URL: ${url || "unknown"}`];

  const [titleText, titleUsed] = truncateWords(title || "", Math.min(remaining, 100));
  remaining -= titleUsed;
  parts.push(`TITLE: ${titleText || "(none)"}`);

  const [bodyText, bodyUsed] = truncateWords(body || "", Math.floor(remaining * 0.6));
  remaining -= bodyUsed;
  parts.push(`BODY:\n${bodyText || "(none)"}`);

  const kept: string[] = [];
  for (const comment of comments ?? []) {
    if (remaining <= 0) break;
    const [text, used] = truncateWords(comment || "", remaining);
    if (!text) continue;
    remaining -= used;
    kept.push(text);
  }

  parts.push(
    kept.length ? `TOP COMMENTS:\n${kept.map((c) => `- ${c}`).join("\n")}` : "TOP COMMENTS: (none)"
  );
  return parts.join("\n\n");
}

/* ------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* ------------------------------------------------------------------------- */

const decodeMap = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const decoded = JSON.parse(value);
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      return decoded as Record<string, unknown>;
    }
  } catch {
    /* A model that writes something other than JSON here loses the field, not
       the whole extraction. */
  }
  return null;
};

const wireToExtraction = (wire: Record<string, unknown>): IdeaExtraction => {
  const idea = { ...wire } as Record<string, unknown>;
  idea.attributes = decodeMap(wire.attributes);
  const rawConfidence = decodeMap(wire.confidence);
  if (rawConfidence) {
    const confidence: Record<string, number> = {};
    for (const [key, value] of Object.entries(rawConfidence)) {
      const asNumber = Number(value);
      if (Number.isFinite(asNumber)) confidence[key] = asNumber;
    }
    idea.confidence = Object.keys(confidence).length ? confidence : null;
  } else {
    idea.confidence = null;
  }
  return idea as IdeaExtraction;
};

export type PostLike = {
  title?: string | null;
  body?: string | null;
  comments?: string[] | null;
  url?: string | null;
  kind?: string | null;
};

/** Pull 0..N reusable event ideas out of one source post.

    Returns an empty list when the post holds no reusable idea, and also when the
    model returns something that will not parse (logged, never thrown, so one bad
    post cannot stall the pipeline). */
export async function extractIdeas(post: PostLike): Promise<IdeaExtraction[]> {
  const config = requireConfig();
  const prompt = buildExtractPrompt(post.title, post.body, post.comments, post.url, post.kind);
  const payload = await generate({
    model: config.extractModel,
    prompt,
    system: EXTRACT_SYSTEM_PROMPT,
    temperature: 0.2,
    responseSchema: EXTRACTION_RESPONSE_SCHEMA,
    timeoutMs: 30_000
  });

  const raw = responseText(payload);
  if (!raw) {
    console.warn("[research] extraction returned no content for", post.url || post.title);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[research] extraction output was not JSON for", post.url || post.title);
    return [];
  }
  const ideas = (parsed as { ideas?: unknown[] })?.ideas;
  if (!Array.isArray(ideas)) return [];
  return ideas
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map(wireToExtraction);
}

/* ------------------------------------------------------------------------- */
/* Triage                                                                     */
/* ------------------------------------------------------------------------- */

/** Cheap first-pass verdict on whether a post deserves full extraction.

    Throws on a malformed response: unlike extraction there is no safe default,
    and the caller records the post as failed rather than silently accepting or
    dropping it. */
export async function triagePost(post: PostLike): Promise<TriageResult> {
  const config = requireConfig();
  const prompt = buildExtractPrompt(
    post.title,
    post.body,
    post.comments,
    post.url,
    post.kind,
    MAX_TRIAGE_WORDS
  );
  const payload = await generate({
    model: config.triageModel,
    prompt,
    system: TRIAGE_SYSTEM_PROMPT,
    temperature: 0,
    responseSchema: TRIAGE_RESPONSE_SCHEMA,
    timeoutMs: 20_000
  });

  const raw = responseText(payload);
  if (!raw) throw new Error(`Triage returned no content for ${post.url || post.title}`);
  const parsed = JSON.parse(raw) as Partial<TriageResult>;
  if (typeof parsed.is_idea !== "boolean" || typeof parsed.category !== "string") {
    throw new Error(`Triage output failed validation for ${post.url || post.title}`);
  }
  return {
    is_idea: parsed.is_idea,
    category: parsed.category,
    corporate_fit: parsed.corporate_fit ?? "unclear",
    india_fit: parsed.india_fit ?? "unclear",
    domain_relevant: parsed.domain_relevant ?? "unclear",
    reason: parsed.reason ?? "",
    confidence: Number(parsed.confidence ?? 0)
  };
}

/* ------------------------------------------------------------------------- */
/* Embeddings                                                                 */
/* ------------------------------------------------------------------------- */

/** Embed texts, preserving order.

    RETRIEVAL_DOCUMENT for ideas being stored, RETRIEVAL_QUERY for a staff
    search, so the two land in the same space with the right asymmetry. */
export async function embed(
  texts: string[],
  taskType: TaskType = "RETRIEVAL_DOCUMENT"
): Promise<number[][]> {
  if (!texts.length) return [];
  const config = requireConfig();
  const vectors: number[][] = [];

  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    const payload = await postJson(
      `models/${config.embedModel}:batchEmbedContents`,
      {
        requests: batch.map((text) => ({
          model: `models/${config.embedModel}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: config.embedDim
        }))
      },
      { timeoutMs: 20_000 }
    );
    const embeddings = (payload.embeddings as Array<{ values?: number[] }> | undefined) ?? [];
    if (embeddings.length !== batch.length) {
      throw new Error(
        `Embedding count mismatch: asked for ${batch.length}, got ${embeddings.length}`
      );
    }
    for (const item of embeddings) vectors.push(item.values ?? []);
  }
  return vectors;
}

/* ------------------------------------------------------------------------- */
/* Answer synthesis                                                           */
/* ------------------------------------------------------------------------- */

/** Write a short recommendation brief over the candidate ideas.

    Each candidate should carry at least an `id`; null fields are kept so the
    model can see, and say, what is unknown. */
export async function answer(needText: string, ideas: unknown[]): Promise<string> {
  if (!ideas.length) {
    return "No candidate ideas matched this need closely enough to recommend.";
  }
  const config = requireConfig();
  const [candidates] = truncateWords(JSON.stringify(ideas, null, 2), MAX_INPUT_WORDS);
  const payload = await generate({
    model: config.answerModel,
    prompt: `PLANNER'S NEED:\n${needText}\n\nCANDIDATE IDEAS:\n${candidates}`,
    system: ANSWER_SYSTEM_PROMPT,
    temperature: 0.3,
    timeoutMs: 30_000
  });
  return responseText(payload).trim();
}

/* ------------------------------------------------------------------------- */
/* Research mode: query expansion                                             */
/* ------------------------------------------------------------------------- */

/** Turn a planner's need into the web and reddit queries to run for it.

    Returns an empty plan (never throws) when the model answers with something
    unusable: a research job with no queries simply finds nothing, which is a
    better outcome than a failed job. */
export async function expandQueries(
  needText: string,
  filters: unknown = null
): Promise<ResearchPlan> {
  const config = requireConfig();
  const parts = [`PLANNER'S NEED:\n${(needText || "").trim() || "(not given)"}`];
  if (filters && Object.keys(filters as object).length) {
    parts.push(`FILTERS THEY SET:\n${JSON.stringify(filters, null, 2)}`);
  }

  try {
    const payload = await generate({
      model: config.answerModel,
      prompt: parts.join("\n\n"),
      system: RESEARCH_PLAN_SYSTEM_PROMPT,
      temperature: 0.4,
      responseSchema: RESEARCH_PLAN_RESPONSE_SCHEMA,
      timeoutMs: 25_000
    });
    const raw = responseText(payload);
    if (!raw) return { web_queries: [], reddit_queries: [] };
    const parsed = JSON.parse(raw) as Partial<ResearchPlan>;
    return {
      web_queries: Array.isArray(parsed.web_queries) ? parsed.web_queries.map(String) : [],
      reddit_queries: Array.isArray(parsed.reddit_queries)
        ? parsed.reddit_queries.map(String)
        : []
    };
  } catch (error) {
    console.warn("[research] query expansion failed:", error);
    return { web_queries: [], reddit_queries: [] };
  }
}

/* ------------------------------------------------------------------------- */
/* Research mode: grounded web search                                         */
/* ------------------------------------------------------------------------- */

const MD_LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

const looksLikeRedirect = (url: string) => url.includes(GROUNDING_REDIRECT_HOST);

/** Resolve one grounding redirect to the page it points at.

    Returns the url unchanged when it is not a redirect, and null when the
    redirect cannot be resolved (the caller drops the hit rather than storing a
    link that expires). The Location header is read without following it: the
    destination often answers 403 to a non-browser client while the header is
    still perfectly good. */
export async function resolveGroundingUrl(
  url: string,
  timeoutMs = 15_000
): Promise<string | null> {
  if (!url) return null;
  if (!looksLikeRedirect(url)) return url;

  const headers = { "User-Agent": BROWSER_UA };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        redirect: "manual",
        headers,
        signal: controller.signal
      });
      const location = response.headers.get("location");
      if (location && location.startsWith("http")) return location;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.info("[research] could not read the redirect for", url.slice(0, 80), error);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        headers,
        signal: controller.signal
      });
      if (response.url && !looksLikeRedirect(response.url)) return response.url;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.info("[research] could not follow the redirect for", url.slice(0, 80), error);
  }
  return null;
}

/** Map each URL the model linked to [title, snippet] from its own prose.

    The grounding chunks only carry the domain as a title, so a readable headline
    has to come from the answer, which cites the same redirect URLs as markdown
    links. The snippet is the model's next line about that page, if it wrote one. */
function linksFromText(text: string): Map<string, [string | null, string | null]> {
  const found = new Map<string, [string | null, string | null]>();
  let pending: string[] = [];

  for (const line of (text || "").split("\n")) {
    const links = [...line.matchAll(MD_LINK_RE)];
    if (links.length) {
      pending = [];
      for (const [, label, url] of links) {
        const cleaned = label.trim().replace(/^[*_\s]+|[*_\s]+$/g, "") || null;
        if (!found.has(url)) {
          found.set(url, [cleaned ? cleaned.slice(0, 300) : null, null]);
          pending.push(url);
        }
      }
      /* The model often writes the whole entry on one line: title as the link,
         then a sentence about the page. Take that sentence if it is there, and
         otherwise wait for the next line. */
      const residual = line
        .replace(MD_LINK_RE, "")
        .trim()
        .replace(/^[*\-–—:•\s]+/, "")
        .trim();
      if (residual.length >= 20) {
        for (const url of pending) {
          const entry = found.get(url)!;
          found.set(url, [entry[0], residual.slice(0, 400)]);
        }
        pending = [];
      }
      continue;
    }

    const stripped = line
      .trim()
      .replace(/^[*\-•\s]+/, "")
      .trim();
    if (!stripped || BARE_URL_RE.test(stripped)) {
      BARE_URL_RE.lastIndex = 0;
      continue;
    }
    for (const url of pending) {
      const entry = found.get(url)!;
      if (entry[1] === null) found.set(url, [entry[0], stripped.slice(0, 400)]);
    }
    pending = [];
  }
  return found;
}

function groundingUrls(payload: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const candidates = (payload.candidates as Array<Record<string, unknown>> | undefined) ?? [];
  for (const candidate of candidates) {
    const metadata = candidate.groundingMetadata as Record<string, unknown> | undefined;
    if (!metadata) continue;
    const chunks = (metadata.groundingChunks as Array<{ web?: { uri?: string } }>) ?? [];
    for (const chunk of chunks) {
      if (chunk.web?.uri) urls.push(String(chunk.web.uri));
    }
  }
  return urls;
}

/** Search the live web for pages about `query`, via Google Search grounding.

    One Gemini call with the google_search tool, then the cited URLs are resolved
    out of Google's redirector. Returns at most MAX_WEB_HITS unique hits, and an
    empty list on any failure: a research job that finds nothing on one query
    still runs its others. */
export async function webSearch(query: string): Promise<WebHit[]> {
  const trimmed = (query || "").trim();
  if (!trimmed) return [];
  const config = requireConfig();

  let payload: Record<string, unknown>;
  try {
    payload = await generate({
      model: config.answerModel,
      prompt: WEB_SEARCH_PROMPT.replace("{query}", trimmed),
      temperature: 0.2,
      tools: [{ google_search: {} }],
      timeoutMs: 40_000
    });
  } catch (error) {
    console.warn("[research] grounded web search failed for", trimmed, error);
    return [];
  }

  const text = responseText(payload);
  const described = linksFromText(text);

  /* Chunks first (Google's own ranking), then anything the model printed but
     did not ground, which is rare but occasionally the only citation there is. */
  const candidates = [
    ...groundingUrls(payload),
    ...described.keys(),
    ...(text.match(BARE_URL_RE) ?? [])
  ];

  const hits: WebHit[] = [];
  const seenRaw = new Set<string>();
  const seenFinal = new Set<string>();
  for (const candidate of candidates) {
    if (hits.length >= MAX_WEB_HITS) break;
    const raw = candidate.replace(/[).,]+$/, "");
    if (seenRaw.has(raw)) continue;
    seenRaw.add(raw);
    const final = await resolveGroundingUrl(raw);
    if (!final || seenFinal.has(final)) continue;
    seenFinal.add(final);
    const [title, snippet] = described.get(raw) ?? [null, null];
    hits.push({ url: final, title, snippet });
  }
  console.info(`[research] grounded search for ${trimmed}: ${hits.length} page(s)`);
  return hits;
}
