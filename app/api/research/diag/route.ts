import { prisma } from "../../../../lib/db";
import { getGeminiConfig, tickConfig } from "../../../../lib/research/config";
import { forbidden, requireResearchUser } from "../../../../lib/research/guard";
import { FEED_USER_AGENT, listingUrl, redditBackoffUntil } from "../../../../lib/research/sources/reddit";

/* Is this deployment actually able to do the work?

   The one thing that cannot be answered from a desk: whether Reddit answers a
   datacentre IP at all. Vercel's egress is shared and Reddit blocks a lot of it,
   so hit one listing feed and one RSS feed for real and report the status codes.
   Two requests, no Gemini spend. */

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const REDDIT_PROBE = listingUrl("eventplanning", "hot", 5);
const RSS_FALLBACK = "https://www.bizbash.com/rss.xml";

async function probe(url: string, userAgent: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent },
      redirect: "follow",
      signal: controller.signal
    });
    const body = await response.text();
    return {
      url,
      status: response.status,
      ok: response.ok,
      bytes: body.length,
      looksLikeFeed: /<(feed|rss)\b/i.test(body.slice(0, 2000)),
      ms: Date.now() - started
    };
  } catch (error) {
    return { url, status: 0, ok: false, error: String(error), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: Request) {
  const user = await requireResearchUser(request);
  if (!user) return forbidden();

  const gemini = getGeminiConfig();
  /* Probe a feed we actually poll, not a guess at one. */
  const rssSource = await prisma.researchSource.findFirst({
    where: { kind: "rss", enabled: true },
    orderBy: { identifier: "asc" },
    select: { identifier: true }
  });

  const [vector, counts, backoff, reddit, rss] = await Promise.all([
    prisma.$queryRaw<Array<{ extname: string; extversion: string }>>`
      SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'
    `,
    prisma.researchPost.groupBy({ by: ["status"], _count: { _all: true } }),
    redditBackoffUntil(),
    probe(REDDIT_PROBE, FEED_USER_AGENT),
    probe(
      rssSource?.identifier ?? RSS_FALLBACK,
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    )
  ]);

  return Response.json({
    gemini: {
      configured: !!gemini,
      triageModel: gemini?.triageModel ?? null,
      extractModel: gemini?.extractModel ?? null,
      answerModel: gemini?.answerModel ?? null,
      embedModel: gemini?.embedModel ?? null,
      embedDim: gemini?.embedDim ?? null
    },
    database: {
      vectorExtension: vector[0] ?? null,
      postCounts: Object.fromEntries(counts.map((row) => [row.status, row._count._all])),
      ideas: await prisma.researchIdea.count(),
      sources: await prisma.researchSource.count()
    },
    cron: { secretConfigured: !!process.env.CRON_SECRET, tick: tickConfig() },
    reddit: { backoffUntil: backoff?.toISOString() ?? null, probe: reddit },
    rss: { probe: rss }
  });
}
