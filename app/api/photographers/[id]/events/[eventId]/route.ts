import { prisma } from "../../../../../../lib/db";
import { getRequestUser } from "../../../../../../lib/rbac-server";
import { createNotification } from "../../../../../../lib/notifications";

/** Revoke a photographer's access to one event. Soft: the grant row stays as an audit trail. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string; eventId: string }> }) {
  const { id: userId, name: userName } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const { id: photographerId, eventId } = await context.params;

  const photographer = await prisma.user.findUnique({
    where: { id: photographerId },
    select: { id: true, name: true, uid: true, role: true }
  });
  if (!photographer || photographer.role !== "PHOTOGRAPHER") {
    return Response.json({ error: "Photographer not found" }, { status: 404 });
  }

  const grant = await prisma.photographerEventAccess.findUnique({
    where: { photographerId_eventId: { photographerId, eventId } },
    select: { revokedAt: true, event: { select: { eventName: true, companyName: true } } }
  });

  /* Idempotent: a second revoke, or one for an event that was never granted, is a no-op
     rather than an error — the panel may well be showing a stale list. The notification is
     only written when something actually changed. */
  if (!grant || grant.revokedAt !== null) return Response.json({ ok: true });

  await prisma.photographerEventAccess.update({
    where: { photographerId_eventId: { photographerId, eventId } },
    data: { revokedAt: new Date(), revokedById: userId }
  });

  await createNotification(
    userId,
    "photographer_access",
    "Photographer event access removed",
    `${userName} removed ${photographer.name} (${photographer.uid}) from ${grant.event.eventName} — ${grant.event.companyName}`
  );

  return Response.json({ ok: true });
}
