import { prisma } from "../../../../lib/db";
import { badRequest, forbidden, requireResearchUser } from "../../../../lib/research/guard";

/* Manage what the tool listens to. */

export const dynamic = "force-dynamic";

const KINDS = ["reddit", "youtube", "rss", "clip", "web"];

export async function GET(request: Request) {
  const user = await requireResearchUser(request);
  if (!user) return forbidden();

  const sources = await prisma.researchSource.findMany({
    orderBy: [{ kind: "asc" }, { identifier: "asc" }],
    select: {
      id: true,
      kind: true,
      identifier: true,
      label: true,
      enabled: true,
      pollIntervalMin: true,
      lastPolledAt: true,
      backoffUntil: true,
      settings: true,
      _count: { select: { posts: true } }
    }
  });

  return Response.json(
    sources.map((source) => ({
      ...source,
      lastPolledAt: source.lastPolledAt?.toISOString() ?? null,
      backoffUntil: source.backoffUntil?.toISOString() ?? null,
      posts: source._count.posts,
      _count: undefined
    }))
  );
}

export async function POST(request: Request) {
  const user = await requireResearchUser(request);
  if (!user) return forbidden();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Body must be JSON");
  }

  const kind = String(body.kind ?? "").trim().toLowerCase();
  const identifier = String(body.identifier ?? "").trim();
  if (!KINDS.includes(kind)) return badRequest(`kind must be one of ${KINDS.join(", ")}`);
  if (!identifier) return badRequest("identifier is required");

  const interval = Number(body.pollIntervalMin ?? 60);
  if (!Number.isFinite(interval) || interval < 0 || interval > 10_080) {
    return badRequest("pollIntervalMin must be between 0 and 10080");
  }

  const existing = await prisma.researchSource.findUnique({
    where: { kind_identifier: { kind: kind as never, identifier } }
  });
  if (existing) return Response.json({ error: "That source is already listed" }, { status: 409 });

  const source = await prisma.researchSource.create({
    data: {
      kind: kind as never,
      identifier,
      label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : identifier,
      enabled: body.enabled !== false,
      pollIntervalMin: Math.trunc(interval)
    }
  });
  console.info(`[research] ${user.name || user.id} added source ${kind}:${identifier}`);
  return Response.json(source);
}
