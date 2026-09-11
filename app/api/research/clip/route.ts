import { prisma } from "../../../../lib/db";
import { badRequest, forbidden, requireResearchUser } from "../../../../lib/research/guard";
import { CLIP_IDENTIFIER, makeClip } from "../../../../lib/research/sources/clip";
import { getOrCreateSource, upsertRawPosts } from "../../../../lib/research/sources/upsert";

/* The staff "clip" inbox: paste a link or a snippet straight into the pipeline.

   A clip is queued like any other post and picked up by the next cron tick. It
   skips triage (a person already decided it was worth the agency's time) but
   goes through extraction, embedding and dedupe exactly like everything else. */

export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await requireResearchUser(request);
  if (!user) return forbidden();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Body must be JSON");
  }

  const asText = (value: unknown) => (typeof value === "string" ? value : null);
  let post;
  try {
    post = await makeClip({
      url: asText(body.url),
      text: asText(body.text),
      title: asText(body.title),
      author: asText(body.author) ?? user.name ?? null,
      note: asText(body.note),
      mediaUrls: Array.isArray(body.mediaUrls) ? body.mediaUrls.map(String) : null
    });
  } catch (error) {
    return badRequest(String(error instanceof Error ? error.message : error));
  }

  const source = await getOrCreateSource("clip", CLIP_IDENTIFIER, "Staff clips", {
    enabled: true,
    pollIntervalMin: 0
  });
  const { inserted, ids } = await upsertRawPosts(source.id, [post]);

  const row = ids[0]
    ? await prisma.researchPost.findUnique({
        where: { id: ids[0] },
        select: { id: true, status: true }
      })
    : null;

  return Response.json({
    id: row?.id ?? null,
    externalId: post.externalId,
    status: row?.status ?? "new",
    duplicate: inserted === 0
  });
}
