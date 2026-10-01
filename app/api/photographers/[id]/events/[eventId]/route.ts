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
  if (!grant || grant.revokedAt !== null) return Response.json({ ok: true, revokedLinks: 0 });

  /* Taking the grant away has to take the links with it.
   *
   * A share token verifies on its own signature and is checked against
   * MediaShare.revokedAt, not against the creator's access — so a link the
   * photographer minted while they held the event keeps serving that event's
   * media to anyone holding the URL long after we cut them off. Removing
   * access has to mean the access they handed out, too.
   *
   * Soft, like everything else here: revokedAt is set, the row survives as the
   * record of what was shared and when it was withdrawn. In one transaction
   * with the grant revoke, so there is no state where access is gone but the
   * links it produced are still live.
   *
   * "Open" is this codebase's definition — not revoked and not expired — the
   * same one /api/share GET uses, so the number returned is the number of links
   * that were actually still working. */
  const now = new Date();
  const revokedLinks = await prisma.$transaction(async (tx) => {
    await tx.photographerEventAccess.update({
      where: { photographerId_eventId: { photographerId, eventId } },
      data: { revokedAt: now, revokedById: userId }
    });

    const killed = await tx.mediaShare.updateMany({
      where: { eventId, createdBy: photographerId, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now }
    });
    return killed.count;
  });

  await createNotification(
    userId,
    "photographer_access",
    "Photographer event access removed",
    `${userName} removed ${photographer.name} (${photographer.uid}) from ${grant.event.eventName} — ${grant.event.companyName}` +
      (revokedLinks > 0
        ? `, and withdrew ${revokedLinks} client link${revokedLinks === 1 ? "" : "s"} they had created`
        : "")
  );

  return Response.json({ ok: true, revokedLinks });
}
