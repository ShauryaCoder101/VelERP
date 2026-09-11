import { prisma } from "../../../../lib/db";
import { badRequest, forbidden, requireResearchUser } from "../../../../lib/research/guard";

/* Operational view: what the pipeline has ingested, skipped and choked on, plus
   the two blunt instruments - requeue everything that failed, and re-triage
   everything the gate threw away (used after the triage prompt changes). */

export const dynamic = "force-dynamic";

const RECENT_LIMIT = 20;
const RECENT_REJECTED_LIMIT = 30;
const RECENT_ACCEPTED_LIMIT = 15;

const POST_SUMMARY = {
  id: true,
  kind: true,
  externalId: true,
  title: true,
  url: true,
  status: true,
  error: true,
  triage: true,
  fetchedAt: true,
  processedAt: true
} as const;

/** Most recently triaged posts with the given verdict.

    Keyed on the stored verdict rather than on status, so a re-triaged or
    already-extracted post still shows what the gate said about it. */
const recentTriaged = (accepted: boolean, take: number) =>
  prisma.researchPost.findMany({
    where: { triage: { path: ["accepted"], equals: accepted } },
    orderBy: [{ processedAt: { sort: "desc", nulls: "last" } }, { fetchedAt: "desc" }],
    take,
    select: POST_SUMMARY
  });

export async function GET(request: Request) {
  const user = await requireResearchUser(request);
  if (!user) return forbidden();

  const [postCounts, ideaCounts, failed, rejected, accepted, searches, jobs] = await Promise.all([
    prisma.researchPost.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.researchIdea.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.researchPost.findMany({
      where: { status: "failed" },
      orderBy: [{ processedAt: { sort: "desc", nulls: "last" } }, { fetchedAt: "desc" }],
      take: RECENT_LIMIT,
      select: POST_SUMMARY
    }),
    recentTriaged(false, RECENT_REJECTED_LIMIT),
    recentTriaged(true, RECENT_ACCEPTED_LIMIT),
    prisma.researchSearch.findMany({
      orderBy: { createdAt: "desc" },
      take: RECENT_LIMIT,
      select: { id: true, needText: true, filters: true, createdAt: true }
    }),
    prisma.researchJob.groupBy({ by: ["status"], _count: { _all: true } })
  ]);

  return Response.json({
    rawPosts: Object.fromEntries(postCounts.map((row) => [row.status, row._count._all])),
    ideas: Object.fromEntries(ideaCounts.map((row) => [row.status, row._count._all])),
    jobs: Object.fromEntries(jobs.map((row) => [row.status, row._count._all])),
    failed,
    triageRejected: rejected,
    triageAccepted: accepted,
    searches
  });
}

export async function POST(request: Request) {
  const user = await requireResearchUser(request);
  if (!user) return forbidden();

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Body must be JSON");
  }
  const action = String(body.action ?? "");

  if (action === "retry-failed") {
    const result = await prisma.researchPost.updateMany({
      where: { status: "failed" },
      data: { status: "new", error: null, processedAt: null }
    });
    console.info(`[research] ${user.name || user.id} requeued ${result.count} failed posts`);
    return Response.json({ requeued: result.count });
  }

  if (action === "retriage") {
    /* The old verdict is left on the row until the tick overwrites it. */
    const result = await prisma.researchPost.updateMany({
      where: { status: "rejected" },
      data: { status: "new", error: null, processedAt: null }
    });
    console.info(`[research] ${user.name || user.id} requeued ${result.count} rejected posts`);
    return Response.json({ requeued: result.count });
  }

  return badRequest("action must be 'retry-failed' or 'retriage'");
}
