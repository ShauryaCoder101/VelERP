import { prisma } from "../../../../lib/db";
import { getUploader } from "../../../../lib/rbac-server";
import { hasEventAccess } from "../../../../lib/photographers";
import { sendUploadEmail } from "../../../../lib/email";

/* Tells the uploader their batch has started or finished.
 *
 * Deliberately batch-level, not per file: a shoot is thousands of files, and an
 * email each would be unusable. Small batches are skipped entirely — they
 * finish in seconds and an email would be noise rather than news. */

const MIN_FILES = 5;
const MIN_BYTES = 200 * 1024 * 1024; // 200MB

export async function POST(request: Request) {
  const uploader = await getUploader(request);
  if (!uploader) return new Response("Forbidden", { status: 403 });
  const { id: userId, name } = uploader;

  const body = await request.json();
  const eventId = String(body.eventId ?? "");

  /* Same gate as the upload itself: an event a photographer cannot upload to is
     also an event whose name they should not learn from an email. */
  if (uploader.isPhotographer && !(await hasEventAccess(userId, eventId))) {
    return Response.json({ error: "You don't have access to this event" }, { status: 403 });
  }

  const fileCount = Number(body.fileCount) || 0;
  const totalBytes = Number(body.totalBytes) || 0;
  const phase = body.phase === "end" ? "end" : "start";

  if (fileCount < MIN_FILES && totalBytes < MIN_BYTES) {
    return Response.json({ sent: false, reason: "batch too small to be worth an email" });
  }

  const [user, event] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } }),
    prisma.event.findUnique({ where: { id: eventId }, select: { eventName: true } })
  ]);

  if (!user?.email) return Response.json({ sent: false, reason: "no address on file" });

  const sent = await sendUploadEmail({
    to: user.email,
    name: user.name || name,
    eventName: event?.eventName ?? "Event media",
    phase,
    fileCount,
    totalBytes,
    failed: Number(body.failed) || 0
  });

  return Response.json({ sent });
}
