import { prisma } from "../../../../lib/db";
import { getRequestUser } from "../../../../lib/rbac-server";
import { sendUploadEmail } from "../../../../lib/email";

/* Tells the uploader their batch has started or finished.
 *
 * Deliberately batch-level, not per file: a shoot is thousands of files, and an
 * email each would be unusable. Small batches are skipped entirely — they
 * finish in seconds and an email would be noise rather than news. */

const MIN_FILES = 5;
const MIN_BYTES = 200 * 1024 * 1024; // 200MB

export async function POST(request: Request) {
  const { id: userId, name } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const body = await request.json();
  const fileCount = Number(body.fileCount) || 0;
  const totalBytes = Number(body.totalBytes) || 0;
  const phase = body.phase === "end" ? "end" : "start";

  if (fileCount < MIN_FILES && totalBytes < MIN_BYTES) {
    return Response.json({ sent: false, reason: "batch too small to be worth an email" });
  }

  const [user, event] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } }),
    prisma.event.findUnique({ where: { id: String(body.eventId ?? "") }, select: { eventName: true } })
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
