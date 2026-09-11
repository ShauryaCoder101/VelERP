import { prisma } from "../../../../../lib/db";
import { forbidden, notFound, requireResearchUser } from "../../../../../lib/research/guard";
import { jobIdeaIds } from "../../../../../lib/research/jobs";
import { rankIdeas } from "../../../../../lib/research/search";
import { firstSourceLinks, hitToJson } from "../../../../../lib/research/serialize";

/* Where the job is, what it has cost, and (once done) what it found.

   The ideas are split in two: ones this job brought into the library, and ones
   it only added a source to. A panel that says "3 new, 2 strengthened" is honest
   in a way that "5 results" is not. */

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const STAGE_LABELS: Record<string, string> = {
  expanding: "Working out what to search for",
  web: "Searching the web and reading pages",
  reddit: "Searching Reddit",
  processing: "Reading everything and pulling out ideas"
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requireResearchUser(request);
  if (!user) return forbidden();

  const { id } = await context.params;
  const job = await prisma.researchJob.findUnique({ where: { id } });
  if (!job) return notFound("Research job not found");

  const { created, strengthened } = job.status === "done"
    ? await jobIdeaIds(job.id)
    : { created: [] as string[], strengthened: [] as string[] };

  const hits = await rankIdeas([...created, ...strengthened], job.needText);
  const createdSet = new Set(created);
  const newIdeas = hits.filter((hit) => createdSet.has(hit.idea.id));
  const strengthenedIdeas = hits.filter((hit) => !createdSet.has(hit.idea.id));

  /* Where each idea came from, so the panel's cards can link out. */
  const links = await firstSourceLinks(hits.map((hit) => hit.idea.id));
  const json = (hit: (typeof hits)[number]) => hitToJson(hit, links.get(hit.idea.id) ?? null);

  return Response.json({
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    stageLabel: job.stage ? STAGE_LABELS[job.stage] ?? null : null,
    needText: job.needText,
    filters: job.filters,
    stats: job.stats ?? {},
    error: job.error,
    searchId: job.searchId,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    ideas: hits.map(json),
    new_ideas: newIdeas.map(json),
    strengthened_ideas: strengthenedIdeas.map(json)
  });
}
