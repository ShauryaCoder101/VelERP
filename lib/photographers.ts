import { Prisma } from "@prisma/client";
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

/* Anything that can run raw SQL: the shared client, or a transaction client
   handed in by an interactive $transaction. Structural rather than
   Prisma.TransactionClient so callers need not import the Prisma namespace. */
type RawExecutor = Pick<typeof prisma, "$executeRaw" | "$queryRaw">;

/* The same, plus the profile delegate. allocateQuota needs both, and it has to
   be able to run inside a caller's transaction: the UploadCharge ledger rows
   that record what an allocation was FOR must commit with the allocation
   itself, or a crash between the two leaves bytes charged with nothing that
   knows why (never refundable) or a ledger row for bytes never taken (refunded
   twice). */
type QuotaExecutor = RawExecutor & Pick<typeof prisma, "photographerProfile">;

/** Idempotent. Pre-existing photographer accounts have no profile row until asked for. */
export const ensureProfile = async (
  userId: string,
  createdById?: string | null,
  db: QuotaExecutor = prisma
): Promise<void> => {
  await db.photographerProfile.upsert({
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
  bytes: number,
  db: QuotaExecutor = prisma
): Promise<{ ok: true } | { ok: false; usedBytes: number; quotaBytes: number }> => {
  await ensureProfile(userId, null, db);

  const amount = BigInt(Math.max(0, Math.floor(bytes)));
  const affected = await db.$executeRaw`
    UPDATE "PhotographerProfile"
       SET "allocatedBytes" = "allocatedBytes" + ${amount}
     WHERE "userId" = ${userId}
       AND "allocatedBytes" + ${amount} <= "quotaBytes"`;

  if (affected > 0) return { ok: true };
  // Read through the same executor: inside a transaction the profile row this
  // call may have just created is not visible to any other connection yet, and
  // the shared client would report "no profile" — a 1 TB allowance and 0 used,
  // which is the opposite of what the caller is about to tell the uploader.
  return { ok: false, ...(await quotaSummary(userId, db)) };
};

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

/* Give bytes back to MANY firms at once — the sweeps' refund.
 *
 * Lives here, beside releaseQuota, so the GREATEST guard has exactly one home;
 * both sweeps call this rather than carrying their own copy of the UPDATE.
 *
 * Why a batch at all: the callers used to issue one releaseQuota per distinct
 * userId inside a single interactive transaction. Prisma 6's interactive
 * transactions time out after 5000 ms and nothing here raises that, so a
 * hundred-row claim spanning sixty firms was sixty-one SEQUENTIAL round trips
 * against that budget — ~4.9 s at a Supabase pooler's ~80 ms, i.e. a P2028 the
 * callers' `.catch` turned into "refunded: 0" with no error anywhere. The same
 * oldest-first rows are then selected by the next sweep and fail the same way,
 * so those firms' quota never comes back: the permanent debit the ledger exists
 * to abolish, reintroduced by the batching that was meant to prevent it. Two
 * statements, whatever the batch size, is the fix.
 *
 * The SELECT ... FOR UPDATE is not redundant. It is what keeps the deadlock
 * argument the callers rely on: two sweeps whose batches overlap must take the
 * PhotographerProfile locks in the same order, and a bare UPDATE ... FROM
 * (VALUES ...) locks rows in whatever order the planner produces. Postgres
 * places the LockRows node ABOVE the Sort, so an ordered SELECT FOR UPDATE
 * acquires the locks in exactly the order it returns them.
 *
 * Returns the total actually handed back, which is what the sweeps report.
 */
export const releaseQuotaMany = async (
  refunds: { userId: string; bytes: number }[],
  db: RawExecutor = prisma
): Promise<number> => {
  /* Collapsed per user — a caller passing the same firm twice must not produce
     two VALUES rows for it, because only one of them would join. */
  const perUser = new Map<string, bigint>();
  for (const { userId, bytes } of refunds) {
    const amount = BigInt(Math.max(0, Math.floor(bytes)));
    if (amount === 0n) continue;
    perUser.set(userId, (perUser.get(userId) ?? 0n) + amount);
  }

  const userIds = [...perUser.keys()].sort();
  if (userIds.length === 0) return 0;

  await db.$queryRaw`
    SELECT 1
      FROM "PhotographerProfile"
     WHERE "userId" IN (${Prisma.join(userIds)})
     ORDER BY "userId"
       FOR UPDATE`;

  await db.$executeRaw`
    UPDATE "PhotographerProfile" p
       SET "allocatedBytes" = GREATEST(p."allocatedBytes" - v.refund, 0)
      FROM (VALUES ${Prisma.join(
        userIds.map((userId) => Prisma.sql`(${userId}::text, ${perUser.get(userId)!}::bigint)`)
      )}) AS v(uid, refund)
     WHERE p."userId" = v.uid`;

  let total = 0;
  for (const amount of perUser.values()) total += Number(amount);
  return total;
};

/* Take this firm's housekeeping slot, or decline to do the housekeeping.
 *
 * Two sweeps run opportunistically on the critical path of starting a file —
 * abandoned presign charges, and abandoned multipart sessions — and both are
 * reachable by anyone holding a forwarded upload link. Unconditionally, a
 * scripted flood pays for one sweep per request: the housekeeping that exists
 * to survive a flood becomes the most expensive part of it, and each sweep is a
 * round trip to storage per row.
 *
 * So the sweep is claimed. ONE conditional UPDATE moves lastSweptAt forward and
 * only the writer that moves it sweeps; everybody else in the same minute gets
 * false and carries on. Conditional rather than read-then-write for the usual
 * reason — N concurrent requests would all read the same stale timestamp and
 * all decide to sweep — and the UPDATE is on a row the request is about to lock
 * for its allocation anyway.
 *
 * The two sweeps deliberately share one slot. They are both "this firm's
 * housekeeping", both bounded by the same storage round trips, and a flood
 * reaches presign and multipart create alike; two columns would just double the
 * work a flood can buy.
 *
 * Zero affected rows also means "no profile row yet", which is correct: a firm
 * with no profile has never been charged and has nothing to sweep.
 *
 * The interval is a SQL literal rather than a parameter on purpose: Postgres
 * will not take a bind parameter inside an `interval` literal, and smuggling
 * one in as a string would turn a constant into something a caller supplies.
 */
export const claimSweepSlot = async (userId: string, db: RawExecutor = prisma): Promise<boolean> => {
  const affected = await db.$executeRaw`
    UPDATE "PhotographerProfile"
       SET "lastSweptAt" = now()
     WHERE "userId" = ${userId}
       AND ("lastSweptAt" IS NULL OR "lastSweptAt" < now() - interval '1 minute')`;
  return affected > 0;
};

/* BigInt cannot be serialised by Response.json, so it is converted at the edge
   of this module. Byte counts stay far below Number.MAX_SAFE_INTEGER (9e15, or
   9 petabytes) so nothing is lost. */
export const quotaSummary = async (
  userId: string,
  db: QuotaExecutor = prisma
): Promise<{ usedBytes: number; quotaBytes: number }> => {
  const profile = await db.photographerProfile.findUnique({
    where: { userId },
    select: { allocatedBytes: true, quotaBytes: true }
  });
  if (!profile) return { usedBytes: 0, quotaBytes: PHOTOGRAPHER_QUOTA_BYTES };
  return { usedBytes: Number(profile.allocatedBytes), quotaBytes: Number(profile.quotaBytes) };
};
