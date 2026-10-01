import { prisma } from "../../../../lib/db";
import { getUploadActor } from "../../../../lib/upload-links";
import { hasEventAccess } from "../../../../lib/photographers";
import { sendUploadEmail } from "../../../../lib/email";

/* Tells the uploader their batch has started or finished.
 *
 * Deliberately batch-level, not per file: a shoot is thousands of files, and an
 * email each would be unusable. Small batches are skipped entirely — they
 * finish in seconds and an email would be noise rather than news. */

const MIN_FILES = 5;
const MIN_BYTES = 200 * 1024 * 1024; // 200MB

/**
 * May an email go out on this contributor's behalf, and claim it if so.
 *
 * This route now accepts link credentials, which means an anonymous caller can
 * reach it: the batch figures in the body are their claim, nothing here proves
 * a single file was uploaded, and a loop would bury the firm's inbox in mail
 * from Velocity's own SMTP. A session user is a known account and is left
 * alone; a contributor has to show an upload.
 *
 * The rule is one email per thing that actually arrived: there must be an
 * Upload row attributed to this person for this event NEWER than the last mail
 * we sent them. Claiming is the conditional update, so two requests racing can
 * only produce one email — the loser's `lastNotifiedAt` no longer matches.
 *
 * A CONTRIBUTOR THEREFORE GETS ONE "FINISHED" EMAIL PER BATCH AND NO "STARTED"
 * ONE. That is the design, not a gap: a start notification is sent before the
 * batch's first file exists, so there is no newer Upload row for it to show and
 * the rule above refuses it every time. lib/media-upload.ts does not even make
 * the call. A signed-in uploader — the firm's main login, or an employee — is a
 * known account, is not rate-limited here, and still gets both.
 */
const claimContributorEmail = async (contributorId: string, eventId: string) => {
  const row = await prisma.uploadContributor.findUnique({
    where: { id: contributorId },
    select: { lastNotifiedAt: true }
  });
  if (!row) return false;

  const fresh = await prisma.upload.findFirst({
    where: {
      contributorId,
      eventId,
      ...(row.lastNotifiedAt ? { createdAt: { gt: row.lastNotifiedAt } } : {})
    },
    select: { id: true }
  });
  if (!fresh) return false;

  const won = await prisma.uploadContributor.updateMany({
    where: { id: contributorId, lastNotifiedAt: row.lastNotifiedAt },
    data: { lastNotifiedAt: new Date() }
  });
  return won.count === 1;
};

export async function POST(request: Request) {
  const uploader = await getUploadActor(request);
  if (!uploader) return new Response("Forbidden", { status: 403 });
  const { id: userId, name } = uploader;

  /* Parsed defensively: with link credentials this is reachable without a
     session, and an empty body must be a 400 rather than an unhandled throw. */
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const eventId = String(body.eventId ?? "");

  // A link authorises ONE event; the firm behind it may hold several.
  if (uploader.contributor && uploader.contributor.eventId !== eventId) {
    return Response.json({ error: "This link is for a different event" }, { status: 403 });
  }

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

  /* Last gate before the mail, because claiming spends the slot whether or not
     the send then succeeds — nothing above this line should be able to burn it. */
  if (uploader.contributor && !(await claimContributorEmail(uploader.contributor.id, eventId))) {
    return Response.json({ sent: false, reason: "nothing new has been uploaded" });
  }

  /* The address is the firm's — a link user has no account and so no address on
     file — so the email has to say which of their people this batch came from,
     or the firm gets "your upload finished" with no idea whose. */
  const firmName = user.name || name;
  const from = uploader.contributor ? `${uploader.contributor.name} via ${firmName}` : firmName;

  const sent = await sendUploadEmail({
    to: user.email,
    name: from,
    eventName: event?.eventName ?? "Event media",
    phase,
    fileCount,
    totalBytes,
    failed: Number(body.failed) || 0
  });

  return Response.json({ sent });
}
