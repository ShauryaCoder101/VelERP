import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "../../../../../../lib/db";
import { getRequestUser } from "../../../../../../lib/rbac-server";
import { resolveForUrl } from "../../../../../../lib/storage";
import { canDeleteArtifact } from "../../../../../../lib/event-artifacts";
import { logUploadFailure } from "../../../../../../lib/upload-health";

/**
 * Delete one artifact.
 *
 * Two things happen, and both matter: the row is soft-deleted, so WHO deleted
 * WHAT survives, and the object is removed from storage, so "delete" means the
 * file is actually gone rather than merely hidden. Deletion is confined to your
 * own uploads, except for the Managing Director, who may delete anything.
 *
 * The lookup is scoped by eventId AND artifactId, so an id guessed from another
 * event cannot be deleted through this event's URL.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; artifactId: string }> }
) {
  const { id: userId, role, status } = await getRequestUser(request);
  if (!userId || status !== "ACTIVE") return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id: eventId, artifactId } = await context.params;

  const artifact = await prisma.eventArtifact.findFirst({
    where: { id: artifactId, eventId },
    select: { id: true, fileUrl: true, uploadedById: true, deletedAt: true }
  });
  if (!artifact) return Response.json({ error: "That file no longer exists" }, { status: 404 });

  /* Deleting twice is harmless: the list the employee is looking at may simply
     be stale, and the second caller should not be told off for agreeing with
     the first. Answered before the permission check on purpose — there is
     nothing left to protect, and a 403 here would be a worse answer than "yes,
     it's gone". */
  if (artifact.deletedAt) return Response.json({ ok: true });

  if (!canDeleteArtifact({ id: userId, role }, artifact)) {
    return Response.json({ error: "You can only delete files you uploaded" }, { status: 403 });
  }

  /* Claimed with a guard on deletedAt, so two callers racing produce one
     deletion record rather than the second overwriting the first's. The loser
     skips the storage call: whoever won is doing it. */
  const won = await prisma.eventArtifact.updateMany({
    where: { id: artifact.id, eventId, deletedAt: null },
    data: { deletedAt: new Date(), deletedById: userId }
  });
  if (won.count !== 1) return Response.json({ ok: true });

  /* Storage second, and best effort. The row is already hidden, which is what
     the employee asked for; a bucket that refuses the delete leaves an orphaned
     object costing storage, and the ONLY trace of that would be this log. It
     must not turn a completed deletion into an error the employee is told to
     retry — the retry would find the row already deleted and change nothing. */
  const resolved = resolveForUrl(artifact.fileUrl);
  if (!resolved) {
    logUploadFailure({
      route: "events/artifacts",
      action: "delete:unresolved",
      userId,
      eventId,
      key: artifact.fileUrl,
      error: new Error("artifact fileUrl does not resolve to any storage profile")
    });
    return Response.json({ ok: true });
  }

  /* The object goes only when nothing else still points at it. Registration
     stores a CANONICAL url and the unique index is per event, so two live rows
     cannot share a key today — this is what keeps the irreversible half of the
     deletion dependent on that invariant rather than on it having held for every
     row ever written. Costs one indexed count against a destructive call. */
  const sharedWith = await prisma.eventArtifact.count({
    // eventId first so the (eventId, fileUrl) unique index serves it; the key embeds the event anyway.
    where: { eventId, fileUrl: artifact.fileUrl, deletedAt: null, NOT: { id: artifact.id } }
  });
  if (sharedWith > 0) {
    logUploadFailure({
      route: "events/artifacts",
      action: "delete:shared-key",
      userId,
      eventId,
      key: resolved.key,
      error: new Error(`${sharedWith} other live artifact row(s) reference this object; left in storage`)
    });
    return Response.json({ ok: true });
  }

  try {
    await resolved.profile.client.send(
      new DeleteObjectCommand({ Bucket: resolved.profile.bucket, Key: resolved.key })
    );
  } catch (error) {
    logUploadFailure({
      route: "events/artifacts",
      action: "delete:object",
      userId,
      eventId,
      key: resolved.key,
      error
    });
  }

  return Response.json({ ok: true });
}
