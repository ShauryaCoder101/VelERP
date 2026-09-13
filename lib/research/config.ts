/* Configuration for the research module.
   Everything is read from the environment at call time (never cached at module
   scope) so a serverless instance picks up a changed value on its next request.
   The Gemini block follows lib/s3.ts: a getter that returns null when the module
   is not configured, so callers degrade instead of throwing. */

export type GeminiConfig = {
  apiKey: string;
  triageModel: string;
  extractModel: string;
  answerModel: string;
  embedModel: string;
  embedDim: number;
};

const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const bool = (name: string, fallback: boolean) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
};

export function getGeminiConfig(): GeminiConfig | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    triageModel: process.env.GEMINI_TRIAGE_MODEL || "gemini-2.5-flash-lite",
    extractModel: process.env.GEMINI_EXTRACT_MODEL || "gemini-3.8-flash",
    answerModel: process.env.GEMINI_ANSWER_MODEL || "gemini-3.8-flash",
    embedModel: process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001",
    embedDim: num("EMBED_DIM", 768)
  };
}

/* Pipeline tuning. Same names and defaults as the Python app.config.Settings. */
export const pipelineConfig = () => ({
  triageStrict: bool("RESEARCH_TRIAGE_STRICT", false),
  dedupeThreshold: num("RESEARCH_DEDUPE_THRESHOLD", 0.92),
  minPostScore: num("RESEARCH_MIN_POST_SCORE", 5),
  minPostChars: num("RESEARCH_MIN_POST_CHARS", 200)
});

/* Hard budgets for one research job. Grounded search is metered and every
   fetched page costs a triage call, so a job can never decide to keep going. */
export const researchBudgets = () => ({
  maxWebQueries: num("RESEARCH_MAX_WEB_QUERIES", 3),
  maxUrls: num("RESEARCH_MAX_URLS", 20),
  maxRedditQueries: num("RESEARCH_MAX_REDDIT_QUERIES", 2)
});

/* What one cron tick is allowed to do. There is no long-running worker here:
   the tick runs for well under a minute and the next one picks up where it
   left off, so every limit below is per-tick, not per-run-of-the-pipeline. */
export const tickConfig = () => ({
  /* Total wall clock for a tick. maxDuration on the route is 60s. */
  budgetMs: num("RESEARCH_TICK_BUDGET_MS", 50_000),
  /* Stop starting new posts once this much of the budget is gone. */
  processDeadlineMs: num("RESEARCH_TICK_PROCESS_MS", 40_000),
  maxSources: num("RESEARCH_TICK_SOURCES", 2),
  maxPosts: num("RESEARCH_TICK_POSTS", 6),
  maxCommentPosts: num("RESEARCH_TICK_COMMENT_POSTS", 1),
  /* One request per tick, i.e. ~1/minute. Reddit documents 10/minute for
     unauthenticated clients, but a shared datacentre IP gets 429 for two feed
     requests a few seconds apart, so the tick spends exactly one: a subreddit
     listing, OR one comment feed, OR one research search. Which of them gets it
     alternates by the minute (see tick.ts). */
  maxRedditRequests: num("RESEARCH_TICK_REDDIT_REQUESTS", 1),
  /* Minimum spacing between two Reddit requests inside one tick. */
  redditSpacingMs: num("RESEARCH_REDDIT_SPACING_MS", 2_000),
  /* How long a source sits out after Reddit answers 429 / 403. */
  redditBackoffMinutes: num("RESEARCH_REDDIT_BACKOFF_MINUTES", 10),
  /* A research job lock older than this is assumed to belong to a tick that
     died mid-step, and may be taken over. */
  jobLockMinutes: num("RESEARCH_JOB_LOCK_MINUTES", 3),
  /* Posts processed per tick while a research job is in its processing stage. */
  jobProcessChunk: num("RESEARCH_JOB_CHUNK", 5)
});

export const cronSecret = () => process.env.CRON_SECRET || "";
