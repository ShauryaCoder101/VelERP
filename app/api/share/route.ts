import { prisma } from "../../../lib/db";
import { getRequestUser } from "../../../lib/rbac-server";
import { createShareToken, MIN_TTL_DAYS, MAX_TTL_DAYS } from "../../../lib/shareToken";

const DAY_MS = 24 * 60 * 60 * 1000;

/* Links are recorded as well as signed. The token still verifies on its own,
   so nothing breaks if a row is missing — but recording it is what lets staff
   see an existing link instead of minting a fifth one for the same event. */

export async function GET(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const eventId = new URL(request.url).searchParams.get("eventId");
  if (!eventId) return Response.json({ error: "Missing eventId" }, { status: 400 });

  // Empty list rather than an error if the migration has not been applied yet.
  try {
    const shares = await prisma.mediaShare.findMany({
      where: { eventId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        folder: true,
        token: true,
        expiresAt: true,
        viewCount: true,
        lastViewedAt: true,
        createdAt: true,
        creator: { select: { name: true } }
      },
      orderBy: { createdAt: "desc" }
    });
    return Response.json(shares);
  } catch {
    return Response.json([]);
  }
}

export async function POST(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const body = await request.json();
  const eventId = typeof body.eventId === "string" ? body.eventId : "";
  if (!eventId) return Response.json({ error: "Missing eventId" }, { status: 400 });

  const requested = Number(body.days);
  const days = Math.min(Math.max(Number.isFinite(requested) ? requested : MIN_TTL_DAYS, MIN_TTL_DAYS), MAX_TTL_DAYS);
  const folder = typeof body.folder === "string" && body.folder ? body.folder : null;

  const { token, expires } = createShareToken(eventId, folder, days * DAY_MS);

  /* The token works whether or not it is recorded, so a missing table costs
     tracking, not the ability to deliver photos to a client today. */
  let tracked = true;
  try {
    await prisma.mediaShare.create({
      data: { eventId, folder, token, createdBy: userId, expiresAt: new Date(expires) }
    });
  } catch {
    tracked = false;
  }

  return Response.json({ token, expires, days, tracked });
}

/* Revoking sets a flag rather than deleting the row, so the history of what was
   shared with whom survives. */
export async function DELETE(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  await prisma.mediaShare.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() }
  });

  return Response.json({ ok: true });
}
