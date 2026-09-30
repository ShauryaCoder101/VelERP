import { AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { prisma } from "./db";
import { getProfile } from "./storage";
import { releaseQuota } from "./photographers";

/* Multipart uploads that nobody ever finished.
 *
 * The browser aborts on failure, but only if the browser is still there. Close
 * the tab mid-upload, lose the laptop's battery, walk out of signal — and the
 * upload stays open forever: its parts sit in the bucket being billed, and for
 * a photographer its bytes stay counted against the 1 TB ceiling. A shoot
 * abandoned three times over would eat quota for files that do not exist.
 *
 * Nothing else can clean this up. R2 lifecycle rules can expire the parts, but
 * they cannot give the quota back, because the quota lives in our database.
 *
 * Safety comes from using the same conditional UPDATE the abort endpoint uses:
 * a row is refunded only by whoever moves it out of OPEN. So the janitor
 * racing a user who finally reconnects and completes, or aborts, cannot pay the
 * refund twice — one of them loses the update and does nothing. */

const DAY_MS = 24 * 60 * 60 * 1000;

/* A cron invocation has a wall-clock budget (maxDuration = 60s on the reminders
   route), and each row costs a storage round trip. Whatever is left over is
   simply swept tomorrow — this is housekeeping, not a deadline. */
const MAX_PER_SWEEP = 500;

export async function sweepAbandonedMultipart(
  olderThanDays = 7
): Promise<{ swept: number; bytesReleased: number }> {
  const cutoff = new Date(Date.now() - Math.max(0, olderThanDays) * DAY_MS);

  const stale = await prisma.multipartSession.findMany({
    where: { state: "OPEN", createdAt: { lt: cutoff } },
    // Oldest first: the ones most certainly dead, and the most expensive to keep.
    orderBy: { createdAt: "asc" },
    take: MAX_PER_SWEEP,
    select: { uploadId: true, userId: true, key: true, purpose: true, bytesCharged: true }
  });

  let swept = 0;
  let bytesReleased = 0;

  for (const session of stale) {
    /* Claim and refund together. Zero rows means the owner got there in the
       interval between the SELECT above and now — their complete or abort owns
       the outcome, refund included.

       One transaction because the refund must be atomic with the transition
       that authorises it: a sweep that died between the two (the cron's 60s
       budget expiring mid-loop is the ordinary way) left the row ABORTED with
       the bytes still charged, and nothing ever looks at a settled row again. */
    const refund = Number(session.bytesCharged);
    const claimed = await prisma
      .$transaction(async (tx) => {
        const won = await tx.multipartSession.updateMany({
          where: { uploadId: session.uploadId, state: "OPEN" },
          data: { state: "ABORTED", closedAt: new Date() }
        });
        if (won.count !== 1) return false;
        if (refund > 0) await releaseQuota(session.userId, refund, tx);
        return true;
      })
      // A row that could not be settled is simply left for the next sweep.
      .catch(() => false);
    if (!claimed) continue;

    swept += 1;
    if (refund > 0) bytesReleased += refund;

    const profile = getProfile(session.purpose === "media" ? "media" : "document");
    if (profile) {
      // Outside the transaction and best effort. A part left in the bucket costs
      // storage; the quota, which is the scarce thing, was settled by the claim.
      await profile.client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: profile.bucket,
            Key: session.key,
            UploadId: session.uploadId
          })
        )
        .catch(() => {});
    }
  }

  return { swept, bytesReleased };
}
