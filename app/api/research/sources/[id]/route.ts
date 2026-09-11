import { prisma } from "../../../../../lib/db";
import {
  badRequest,
  forbidden,
  notFound,
  requireResearchUser
} from "../../../../../lib/research/guard";

/* Toggle a source on or off, retune its interval, or clear a Reddit backoff.
   The next tick reads whatever this leaves behind. */

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requireResearchUser(request);
  if (!user) return forbidden();

  const { id } = await context.params;
  const source = await prisma.researchSource.findUnique({ where: { id } });
  if (!source) return notFound("Source not found");

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* An empty body means "just toggle enabled", which is what the list view
       sends when someone flips the switch. */
  }

  const data: Record<string, unknown> = {};
  if (typeof body.enabled === "boolean") data.enabled = body.enabled;
  else if (body.enabled === undefined) data.enabled = !source.enabled;
  else return badRequest("enabled must be a boolean");

  if (body.pollIntervalMin !== undefined) {
    const interval = Number(body.pollIntervalMin);
    if (!Number.isFinite(interval) || interval < 0 || interval > 10_080) {
      return badRequest("pollIntervalMin must be between 0 and 10080");
    }
    data.pollIntervalMin = Math.trunc(interval);
  }
  if (typeof body.label === "string") data.label = body.label.trim() || null;
  if (body.clearBackoff === true) data.backoffUntil = null;

  const updated = await prisma.researchSource.update({ where: { id }, data });
  console.info(
    `[research] ${user.name || user.id} updated source ${updated.kind}:${updated.identifier} enabled=${updated.enabled}`
  );
  return Response.json({
    ...updated,
    lastPolledAt: updated.lastPolledAt?.toISOString() ?? null,
    backoffUntil: updated.backoffUntil?.toISOString() ?? null
  });
}
