import { prisma } from "../../../../lib/db";
import { verifyShareToken } from "../../../../lib/shareToken";
import { buildMediaItems } from "../../../../lib/media-items";

/* Public endpoint — no session. The token is the entire authorisation, so this
   deliberately returns only what a client should see: the event's name, dates
   and its media. No vendors, no finances, no contact details, no staff emails.

   Token verification and revocation stay here. Only the item building moved to
   lib/media-items.ts, which is shared with the photographer gallery — nothing
   in there checks permission, so this must. */

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const payload = verifyShareToken(token);
  if (!payload) {
    return Response.json({ error: "This link is invalid or has expired." }, { status: 410 });
  }

  /* The signature alone is enough to open a link — links issued before tracking
     existed have no row and must keep working. But if a row is present and has
     been revoked, that wins over the signature.

     The lookup is deliberately fault-tolerant: if the MediaShare table is not
     there yet (code deployed ahead of the migration), a client opening their
     gallery must not see an error page. Tracking is the thing that degrades,
     never the delivery. */
  let record: { id: string; revokedAt: Date | null } | null = null;
  try {
    record = await prisma.mediaShare.findUnique({
      where: { token },
      select: { id: true, revokedAt: true }
    });
  } catch {
    record = null;
  }

  if (record?.revokedAt) {
    return Response.json({ error: "This link has been withdrawn." }, { status: 410 });
  }
  if (record) {
    // Best effort: a failed counter must never stop a client seeing their photos.
    prisma.mediaShare
      .update({
        where: { id: record.id },
        data: { viewCount: { increment: 1 }, lastViewedAt: new Date() }
      })
      .catch(() => {});
  }

  const event = await prisma.event.findUnique({
    where: { id: payload.e },
    select: { id: true, eventName: true, companyName: true, fromDate: true, toDate: true }
  });

  if (!event) return Response.json({ error: "This link is no longer available." }, { status: 404 });

  // Never outlive the link itself.
  const remaining = Math.floor((payload.x - Date.now()) / 1000);
  const expiresIn = Math.max(60, Math.min(60 * 60, remaining));

  /* No viewerId: a client is not a user of ours, so "mine" means nothing here
     and is left off the items entirely. */
  const items = await buildMediaItems({ eventId: event.id, folder: payload.f, expiresIn });

  return Response.json({
    event: {
      name: event.eventName,
      company: event.companyName,
      fromDate: event.fromDate,
      toDate: event.toDate
    },
    folder: payload.f,
    expires: payload.x,
    items
  });
}
