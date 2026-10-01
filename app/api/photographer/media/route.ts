import { prisma } from "../../../../lib/db";
import { getUploader } from "../../../../lib/rbac-server";
import { hasEventAccess } from "../../../../lib/photographers";
import { buildMediaItems } from "../../../../lib/media-items";

/* Everything shot at an event a photographer holds a grant for — not only the
 * files they personally uploaded.
 *
 * A wedding is covered by three or four photographers at once, and the second
 * shooter needs to see what the first already delivered before deciding what to
 * re-shoot or hand over. Ownership is still reported per item (`mine`) so the
 * UI can say which are theirs; it just is not a filter any more.
 *
 * The rule this endpoint sits inside: a photographer may VIEW and SHARE the
 * media of a granted event, and can never delete a photo or a client link.
 * There is no delete here, and none anywhere else a photographer can reach —
 * the only code that removes Upload rows is the employee-only event DELETE.
 *
 * Employees are refused rather than served, so nobody wires an employee screen
 * to this and quietly makes it the source of truth for an event's gallery. */

/** Signed URLs live an hour; the gallery refetches rather than holding them. */
const URL_TTL_SECONDS = 60 * 60;

export async function GET(request: Request) {
  const uploader = await getUploader(request);
  if (!uploader) return new Response("Forbidden", { status: 403 });
  if (!uploader.isPhotographer) {
    return Response.json({ error: "This is for photographer accounts" }, { status: 403 });
  }

  const eventId = new URL(request.url).searchParams.get("eventId");
  if (!eventId) return Response.json({ error: "Missing eventId" }, { status: 400 });

  if (!(await hasEventAccess(uploader.id, eventId))) {
    return Response.json({ error: "You don't have access to this event" }, { status: 403 });
  }

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, eventName: true, companyName: true, fromDate: true, toDate: true }
  });
  if (!event) return Response.json({ error: "That event no longer exists" }, { status: 404 });

  /* folder null: the grant is over the whole event, not a slice of it — that
     scoping only exists for client links. */
  /* withUploader: the firm's open links mean most of what is here was sent by
     one of its photographers in the field, all of it under the firm's single
     account. Without a name per file the main login sees thirty people's work
     with its own name on every row. */
  const items = await buildMediaItems({
    eventId: event.id,
    folder: null,
    expiresIn: URL_TTL_SECONDS,
    viewerId: uploader.id,
    withUploader: true
  });

  return Response.json({
    event: {
      id: event.id,
      name: event.eventName,
      company: event.companyName,
      fromDate: event.fromDate,
      toDate: event.toDate
    },
    items
  });
}
