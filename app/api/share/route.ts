import { getRequestUser } from "../../../lib/rbac-server";
import { createShareToken, MIN_TTL_DAYS, MAX_TTL_DAYS } from "../../../lib/shareToken";

const DAY_MS = 24 * 60 * 60 * 1000;

/* Staff mint a client link here. Anyone signed in may share an event they can
   already see; the link itself carries no credentials of theirs. */
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
  return Response.json({ token, expires, days });
}
