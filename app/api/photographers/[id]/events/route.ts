import { prisma } from "../../../../../lib/db";
import { getRequestUser } from "../../../../../lib/rbac-server";
import { createNotification } from "../../../../../lib/notifications";
import { ensureProfile } from "../../../../../lib/photographers";

/** Grant a photographer upload access to one event. Any employee may do this, for any event. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: userId, name: userName } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const { id: photographerId } = await context.params;
  const body = await request.json().catch(() => null);
  const eventId = typeof body?.eventId === "string" ? body.eventId : "";
  if (!eventId) return Response.json({ error: "Select an event" }, { status: 400 });

  // Same PHOTOGRAPHER-only guardrail as PATCH: a grant row pointing at an employee would
  // give that employee a second, unaudited route into an event.
  const photographer = await prisma.user.findUnique({
    where: { id: photographerId },
    select: { id: true, name: true, uid: true, role: true, status: true }
  });
  if (!photographer || photographer.role !== "PHOTOGRAPHER") {
    return Response.json({ error: "Photographer not found" }, { status: 404 });
  }
  if (photographer.status !== "ACTIVE") {
    return Response.json({ error: "Reactivate this account before granting event access" }, { status: 400 });
  }

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, eventName: true, companyName: true }
  });
  if (!event) return Response.json({ error: "Event not found" }, { status: 404 });

  // A profile may not exist yet for a photographer created before this feature; the grant
  // is meaningless without the quota row the upload routes read.
  await ensureProfile(photographerId);

  /* Upsert on the unique pair rather than insert: re-granting an event that was revoked has
     to clear revokedAt on the row that is already there, so "is it revoked?" keeps exactly
     one answer. */
  await prisma.photographerEventAccess.upsert({
    where: { photographerId_eventId: { photographerId, eventId } },
    create: { photographerId, eventId, grantedById: userId },
    update: { grantedById: userId, grantedAt: new Date(), revokedAt: null, revokedById: null }
  });

  await createNotification(
    userId,
    "photographer_access",
    "Photographer event access granted",
    `${userName} gave ${photographer.name} (${photographer.uid}) access to ${event.eventName} — ${event.companyName}`
  );

  return Response.json({ ok: true });
}
