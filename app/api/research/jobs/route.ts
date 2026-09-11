import { prisma } from "../../../../lib/db";
import { forbidden, requireResearchUser } from "../../../../lib/research/guard";

/* The research log: every job, what it searched for and what it found. */

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export async function GET(request: Request) {
  const user = await requireResearchUser(request);
  if (!user) return forbidden();

  const url = new URL(request.url);
  const take = Math.min(Math.max(Number(url.searchParams.get("limit") ?? PAGE_SIZE) || PAGE_SIZE, 1), 200);
  const status = url.searchParams.get("status");

  const jobs = await prisma.researchJob.findMany({
    where: status ? { status: status as never } : undefined,
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      needText: true,
      filters: true,
      status: true,
      stage: true,
      stats: true,
      error: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      searchId: true,
      _count: { select: { posts: true, ideas: true } }
    }
  });

  return Response.json({
    count: jobs.length,
    jobs: jobs.map((job) => ({
      ...job,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      posts: job._count.posts,
      ideas: job._count.ideas,
      _count: undefined
    }))
  });
}
