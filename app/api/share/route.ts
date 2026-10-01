import { prisma } from "../../../lib/db";
import { getRequestUser, getUploader } from "../../../lib/rbac-server";
import { hasEventAccess } from "../../../lib/photographers";
import { createShareToken, MIN_TTL_DAYS, MAX_TTL_DAYS } from "../../../lib/shareToken";

const DAY_MS = 24 * 60 * 60 * 1000;

/* Links are recorded as well as signed. The token still verifies on its own,
   so nothing breaks if a row is missing — but recording it is what lets staff
   see the links that are already open instead of minting another one.

   There is deliberately no cap on links per event: a big wedding goes out to
   the couple, both families and the venue separately, each with its own link so
   one can be withdrawn without killing the others.

   Who may do what:
     see an event's links   employees see every link on the event; a granted
                            photographer sees only the links they created
     see EVERY open link    employees only  (?all=1 — it spans events they may
                            not be on, so it is never reachable by a third party)
     create a link          employees, and a photographer granted that event
     delete a link          employees only

   The last line is the load-bearing one. A photographer may view and share the
   media of a granted event; they can never delete a photo or a client link. */

const forbidden = () => new Response("Forbidden", { status: 403 });

type Caller = { id: string; isPhotographer: boolean };

/* Resolve the caller for an event-scoped action: an employee, or a photographer
   holding an active grant for this event. Returns the Response to send when
   neither holds, so the reason travels with the refusal. */
const callerForEvent = async (request: Request, eventId: string): Promise<Caller | Response> => {
  const employee = await getRequestUser(request);
  if (employee.id) return { id: employee.id, isPhotographer: false };

  /* getRequestUser returns the anonymous shape for a photographer, so an empty
     id above means "not an employee", not "not signed in". Ask again through
     the only door photographers come through. */
  const uploader = await getUploader(request);
  if (!uploader || !uploader.isPhotographer) return forbidden();
  if (!(await hasEventAccess(uploader.id, eventId))) {
    return Response.json({ error: "You don't have access to this event" }, { status: 403 });
  }
  return { id: uploader.id, isPhotographer: true };
};

const SHARE_FIELDS = {
  id: true,
  folder: true,
  token: true,
  expiresAt: true,
  viewCount: true,
  lastViewedAt: true,
  createdAt: true,
  /* role, not a boolean, because it is the raw RoleName enum on User. Mapped to
     isPhotographer at the edge so the client never has to know the enum. */
  creator: { select: { name: true, role: true } }
} as const;

type ShareRow = {
  id: string;
  folder: string | null;
  token: string;
  expiresAt: Date;
  viewCount: number;
  lastViewedAt: Date | null;
  createdAt: Date;
  creator: { name: string; role: string };
};

const shape = (share: ShareRow) => ({
  id: share.id,
  folder: share.folder,
  token: share.token,
  expiresAt: share.expiresAt,
  viewCount: share.viewCount,
  lastViewedAt: share.lastViewedAt,
  createdAt: share.createdAt,
  creator: { name: share.creator.name, isPhotographer: share.creator.role === "PHOTOGRAPHER" }
});

/** A tracker of every open link is a page, not a scroll — bound it. */
const ALL_LINKS_LIMIT = 1000;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  /* The cross-event tracker. Employees only, and checked before eventId is even
     read: a photographer must not be able to enumerate events they were never
     granted by leaving eventId off. */
  if (params.get("all")) {
    const { id: userId } = await getRequestUser(request);
    if (!userId) return forbidden();

    // Empty list rather than an error if the migration has not been applied yet.
    try {
      const shares = await prisma.mediaShare.findMany({
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
        select: {
          ...SHARE_FIELDS,
          event: { select: { id: true, eventName: true, companyName: true } }
        },
        orderBy: { createdAt: "desc" },
        take: ALL_LINKS_LIMIT
      });
      return Response.json({ links: shares.map((s) => ({ ...shape(s), event: s.event })) });
    } catch {
      return Response.json({ links: [] });
    }
  }

  const eventId = params.get("eventId");
  if (!eventId) return Response.json({ error: "Missing eventId" }, { status: 400 });

  const caller = await callerForEvent(request, eventId);
  if (caller instanceof Response) return caller;

  try {
    const shares = await prisma.mediaShare.findMany({
      where: {
        eventId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        /* A photographer sees only their own links, and the row carries the
           token. Listing every link on the event handed a third party the
           token staff had mailed to the client — one they could keep opening
           long after their grant was removed, since a share token verifies on
           its own and nothing would revoke it. Employees still see them all;
           the tracker is theirs. */
        ...(caller.isPhotographer ? { createdBy: caller.id } : {})
      },
      select: SHARE_FIELDS,
      orderBy: { createdAt: "desc" }
    });
    return Response.json(shares.map(shape));
  } catch {
    return Response.json([]);
  }
}

export async function POST(request: Request) {
  /* Parsed defensively because the gate below needs the body: an empty or
     malformed POST has to come back as a 400 the caller can read, not as an
     unhandled throw that Next renders as a 500. */
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Missing eventId" }, { status: 400 });
  }

  const eventId = typeof body.eventId === "string" ? body.eventId : "";
  if (!eventId) return Response.json({ error: "Missing eventId" }, { status: 400 });

  /* Gating needs the eventId, so the body is read first. Nothing is written
     before the check below, so an unauthorised caller still changes nothing. */
  const caller = await callerForEvent(request, eventId);
  if (caller instanceof Response) return caller;

  const requested = Number(body.days);
  const days = Math.min(Math.max(Number.isFinite(requested) ? requested : MIN_TTL_DAYS, MIN_TTL_DAYS), MAX_TTL_DAYS);
  const folder = typeof body.folder === "string" && body.folder ? body.folder : null;

  const { token, expires } = createShareToken(eventId, folder, days * DAY_MS);

  /* The token works whether or not it is recorded, so a missing table costs
     tracking, not the ability to deliver photos to a client today.

     That trade only holds for an employee. An untracked link appears in no
     tracker and has no row to set revokedAt on, so staff cannot withdraw it —
     it is a bearer token to the event's media that outlives any decision they
     make. Handing one to an employee is a degraded but accountable day; handing
     one to a third party creates access nobody can take back. So for a
     photographer a failed insert is a failure, and no token leaves here. */
  let tracked = true;
  try {
    await prisma.mediaShare.create({
      data: { eventId, folder, token, createdBy: caller.id, expiresAt: new Date(expires) }
    });
  } catch {
    if (caller.isPhotographer) {
      return Response.json({ error: "Couldn't create the link. Please try again." }, { status: 500 });
    }
    tracked = false;
  }

  return Response.json({ token, expires, days, tracked });
}

/* Revoking sets a flag rather than deleting the row, so the history of what was
   shared with whom survives. The UI calls it "Delete"; the record stays.

   Employees only. A photographer can create a link for an event they are on but
   never withdraw one — a third party must not be able to cut off a client's
   access to their own photos, or quietly erase a colleague's link. The refusal
   goes through getUploader rather than falling out of getRequestUser's
   anonymous shape, so the photographer is told why instead of getting a bare
   "Forbidden" that reads like a broken session. */
export async function DELETE(request: Request) {
  const uploader = await getUploader(request);
  if (!uploader) return forbidden();
  if (uploader.isPhotographer) {
    return Response.json({ error: "Only Velocity staff can delete a client link" }, { status: 403 });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  await prisma.mediaShare.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() }
  });

  return Response.json({ ok: true });
}
