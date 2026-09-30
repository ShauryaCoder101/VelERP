import { prisma } from "./db";

/* Third-party photographer quotas and event access.
 *
 * Server-only: every function here talks to the database.
 *
 * The threat this exists for is mundane rather than clever. A photographer is
 * handed credentials by whichever employee is running the shoot, and uploads
 * multi-gigabyte video straight into our R2 bucket. Nothing stops one of them
 * pointing a sync tool at it and parking a few hundred terabytes on our bill.
 * A per-account ceiling is the cheapest thing that makes that impossible. */

/** 1 TB, in bytes. Decimal, not binary — it is a billing number, not a disk. */
export const PHOTOGRAPHER_QUOTA_BYTES = 1_000_000_000_000;

/* Derivatives are browser-generated JPEGs, a few hundred KB at most. The caps
   are generous but finite: without them a photographer could ask for a 500GB
   "thumbnail" slot and bypass the original's accounting entirely. */
export const THUMB_MAX_BYTES = 2 * 1024 * 1024;
export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/** Idempotent. Pre-existing photographer accounts have no profile row until asked for. */
export const ensureProfile = async (userId: string, createdById?: string | null): Promise<void> => {
  await prisma.photographerProfile.upsert({
    where: { userId },
    create: {
      userId,
      quotaBytes: BigInt(PHOTOGRAPHER_QUOTA_BYTES),
      createdById: createdById ?? null
    },
    // Never reset a quota or reassign authorship on a second call.
    update: {}
  });
};

export const hasEventAccess = async (photographerId: string, eventId: string): Promise<boolean> => {
  if (!photographerId || !eventId) return false;
  const grant = await prisma.photographerEventAccess.findUnique({
    where: { photographerId_eventId: { photographerId, eventId } },
    select: { revokedAt: true }
  });
  return Boolean(grant && grant.revokedAt === null);
};

export const grantedEvents = async (
  photographerId: string
): Promise<{ id: string; eventName: string; companyName: string; fromDate: Date; toDate: Date }[]> => {
  const grants = await prisma.photographerEventAccess.findMany({
    where: { photographerId, revokedAt: null },
    select: {
      event: { select: { id: true, eventName: true, companyName: true, fromDate: true, toDate: true } }
    },
    orderBy: { grantedAt: "desc" }
  });
  return grants.map((g) => g.event);
};

/* Reserve `bytes` against the ceiling, or refuse.
 *
 * Deliberately ONE conditional UPDATE rather than a read, a comparison and a
 * write. A photographer uploads with several parts in flight at once: two
 * requests that each read 999GB used, each decide 2GB is fine, and each then
 * write 1001GB would put us 1GB over with both having "passed" the check. The
 * database decides here instead — the row is locked for the duration of the
 * UPDATE, so the second request sees the first one's bytes. Zero affected rows
 * means the sum would have breached the ceiling. */
export const allocateQuota = async (
  userId: string,
  bytes: number
): Promise<{ ok: true } | { ok: false; usedBytes: number; quotaBytes: number }> => {
  await ensureProfile(userId);

  const amount = BigInt(Math.max(0, Math.floor(bytes)));
  const affected = await prisma.$executeRaw`
    UPDATE "PhotographerProfile"
       SET "allocatedBytes" = "allocatedBytes" + ${amount}
     WHERE "userId" = ${userId}
       AND "allocatedBytes" + ${amount} <= "quotaBytes"`;

  if (affected > 0) return { ok: true };
  return { ok: false, ...(await quotaSummary(userId)) };
};

/* Anything that can run raw SQL: the shared client, or a transaction client
   handed in by an interactive $transaction. Structural rather than
   Prisma.TransactionClient so callers need not import the Prisma namespace. */
type RawExecutor = Pick<typeof prisma, "$executeRaw">;

/* Give bytes back — for a multipart upload that was aborted, so never became an
 * object.
 *
 * `db` exists so the refund can be enlisted in the SAME transaction as the
 * OPEN -> ABORTED claim that authorises it. Claim and refund as separate
 * statements means a crash in between keeps the bytes charged forever against a
 * row nothing will ever revisit, and duplicating this UPDATE at each call site
 * would be a second place for the GREATEST guard to go missing. */
export const releaseQuota = async (userId: string, bytes: number, db: RawExecutor = prisma): Promise<void> => {
  const amount = BigInt(Math.max(0, Math.floor(bytes)));
  if (amount === 0n) return;
  // GREATEST keeps a double release from driving the counter negative, which
  // would silently hand out free quota.
  await db.$executeRaw`
    UPDATE "PhotographerProfile"
       SET "allocatedBytes" = GREATEST("allocatedBytes" - ${amount}, 0)
     WHERE "userId" = ${userId}`;
};

/* BigInt cannot be serialised by Response.json, so it is converted at the edge
   of this module. Byte counts stay far below Number.MAX_SAFE_INTEGER (9e15, or
   9 petabytes) so nothing is lost. */
export const quotaSummary = async (userId: string): Promise<{ usedBytes: number; quotaBytes: number }> => {
  const profile = await prisma.photographerProfile.findUnique({
    where: { userId },
    select: { allocatedBytes: true, quotaBytes: true }
  });
  if (!profile) return { usedBytes: 0, quotaBytes: PHOTOGRAPHER_QUOTA_BYTES };
  return { usedBytes: Number(profile.allocatedBytes), quotaBytes: Number(profile.quotaBytes) };
};
