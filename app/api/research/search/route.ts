import { createJob } from "../../../../lib/research/jobs";
import { badRequest, forbidden, requireResearchUser } from "../../../../lib/research/guard";
import { activeFilters, normaliseFilters, search } from "../../../../lib/research/search";
import { hitToJson } from "../../../../lib/research/serialize";

/* Search the library. Every filter is optional and blank means "don't care";
   an idea is only ever excluded by a field it actually carries.

   `research: true` additionally queues a research job that goes outside the
   library. The search itself still returns from the library immediately - the
   job is picked up by the cron tick and the caller polls
   GET /api/research/jobs/<id> for it. */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_K = 100;

export async function POST(request: Request) {
  const user = await requireResearchUser(request);
  if (!user) return forbidden();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Body must be JSON");
  }

  const needText = typeof body.needText === "string" ? body.needText : "";
  const filters = normaliseFilters(body.filters);
  const k = Math.min(Math.max(Number(body.k ?? 20) || 20, 1), MAX_K);
  const synthesize = body.synthesize !== false;

  const result = await search({ needText, filters, k, synthesize, userId: user.id });

  let jobId: string | null = null;
  if (body.research === true) {
    const job = await createJob({
      needText,
      filters: activeFilters(filters),
      searchId: result.searchId,
      userId: user.id
    });
    jobId = job.id;
  }

  return Response.json({
    searchId: result.searchId,
    jobId,
    answer: result.answer,
    count: result.ideas.length,
    ideas: result.ideas.map(hitToJson)
  });
}
