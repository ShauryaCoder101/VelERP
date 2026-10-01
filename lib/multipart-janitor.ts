import { AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { getProfile } from "./storage";
import { releaseQuotaMany } from "./photographers";

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

/* How long a part signature lives.
 *
 * It lives HERE rather than in the route that mints the signatures because the
 * only other thing that depends on it is the inactivity threshold below, and the
 * two must not be able to drift apart: shorten the signature and the threshold
 * has to shorten with it or dead sessions linger; lengthen it without lengthening
 * the threshold and a live upload gets swept out from under its own URLs. */
export const PART_EXPIRY_SECONDS = 6 * 60 * 60;

/* After this much silence an OPEN session provably cannot continue.
 *
 * MultipartSession.lastActivityAt is stamped at create and refreshed by every
 * successful `sign`, so the newest part URL a session ever received was issued at
 * lastActivityAt and dies at lastActivityAt + PART_EXPIRY_SECONDS. Past that the
 * client cannot upload another part without calling `sign` again — which would
 * have moved lastActivityAt. The upload is not "probably dead"; it is unable to
 * advance.
 *
 * The client (lib/upload-client.ts) signs EVERY part up front, in batches of 500,
 * and then uploads them three at a time without signing again. So a legitimate
 * multi-hour upload makes no sign call at all between its create and its 6-hour
 * mark — which is exactly why the threshold is anchored on signature expiry
 * rather than on "no request for a while". When a part URL does expire mid-upload
 * the client's own 403 branch re-signs that part, and that refreshes the stamp.
 *
 * The extra hour is for a PUT that started just before its signature expired: S3
 * and R2 check expiry at request start, so such a part keeps streaming and must
 * be allowed to land. One hour is far more than a 16-32MB part needs on any
 * connection that is still working — and a part that genuinely takes longer than
 * that will be retried by the client, which re-signs it and moves the stamp. */
export const INACTIVITY_MS = (PART_EXPIRY_SECONDS + 60 * 60) * 1000;

/* The backstop the inactivity rule cannot provide for itself.
 *
 * lastActivityAt is refreshed by every successful `sign`, and `sign` is a call
 * the holder of an upload ticket can make whenever they like — a ticket lives
 * seven days. So an inactivity-only rule is a clock the subject of the sweep
 * controls: declare the largest size the pending cap allows, upload nothing,
 * and sign one part an hour, and no sweep ever selects the row. A client stuck
 * in a re-sign retry loop does it by accident. Removing the old unconditional
 * "OPEN for more than 7 days" bound without replacing it did not tighten the
 * rule, it made it renewable — and the firm-wide cap was raised to 250 GB on
 * the strength of dead sessions recycling within hours.
 *
 * So: however recent the activity, an OPEN session older than its age bound is
 * swept. Two days is the FLOOR of that bound, not the whole of it — see
 * sessionAgeBoundMs. */
export const MAX_SESSION_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/* Bytes a 1 Mbit/s line moves in a millisecond: 1e6 bits/s = 125 bytes/ms.
 *
 * The age backstop has to be an upload nobody could still be making, and "two
 * days" is only that for a file small enough to fit in two days. A contributor
 * may declare up to MAX_PENDING_PER_CONTRIBUTOR_BYTES (64 GB), which needs
 * ~3.2 Mbit/s sustained for two days — so a flat two-day bound quietly means
 * "shoots on slow connections lose their biggest file", and it fails silently:
 * the client sees a 409 after hours of uploading, with nothing saying why.
 *
 * 1 Mbit/s is the slowest line on which this product is worth using and is far
 * below what any real uploader has, so a session swept on age had the whole
 * window a terrible connection would have needed and still did not finish. It
 * scales the right way: everything up to ~21.6 GB keeps the two-day floor
 * (that is what 1 Mbit/s moves in two days), 64 GiB gets ~6.4 days, and the
 * bound can never be stretched by the session's holder because it is a
 * function of the size they declared at create — which the signed part lengths
 * then hold them to. */
const BYTES_PER_MS_AT_1_MBIT = 125;

/* The absolute age at which an OPEN session is swept regardless of activity is
   therefore, in milliseconds:

     max(MAX_SESSION_AGE_MS, fileSize / BYTES_PER_MS_AT_1_MBIT)

   It is evaluated per row by the database rather than in JavaScript — see
   selectStale, and the note there on why a JS filter applied after `take` could
   not be made to work. */

/* A cron invocation has a wall-clock budget (maxDuration = 60s on the reminders
   route), and each row costs a storage round trip. Whatever is left over is
   simply swept tomorrow — this is housekeeping, not a deadline. The arithmetic
   that says 500 fits is in /api/cron/reminders. */
const MAX_PER_SWEEP = 500;

/* How many sessions one claiming transaction covers. Same trade-off as the
   charge ledger's CLAIM_BATCH: few enough transactions that a 500-row sweep is
   not 500 round trips, small enough that a sweep killed by the cron's 60s
   budget has already committed all but the last partial batch. */
const CLAIM_BATCH = 100;

type StaleSession = {
  uploadId: string;
  userId: string;
  key: string;
  purpose: string;
  bytesCharged: bigint;
  fileSize: bigint;
  createdAt: Date;
  lastActivityAt: Date | null;
};

/* Claim a BATCH of abandoned sessions and refund them — in ONE transaction.
 *
 * The single copy of this logic. The daily cron sweep and the per-firm sweep at
 * multipart create differ only in which rows they select — a second
 * implementation of the claim would be a second place for the "refund rides on
 * the OPEN -> ABORTED transition" rule to go missing, and that rule is the whole
 * reason a photographer cannot loop abort and reset their usage to zero.
 *
 * RETURNING is what keeps that rule intact while batching. The UPDATE moves
 * only rows that are still OPEN and hands back exactly those, so a session
 * whose owner completed or aborted it in the gap since the SELECT simply is not
 * in the result and is not refunded — the same guarantee the per-row
 * updateMany gave, for the whole batch at once.
 *
 * One transaction because the refund must be atomic with the transition that
 * authorises it: a sweep that died between the two (the cron's 60s budget
 * expiring mid-loop is the ordinary way) left rows ABORTED with their bytes
 * still charged, and nothing ever looks at a settled row again.
 *
 * Users are refunded in sorted order so two concurrent sweeps covering
 * overlapping firms cannot take the PhotographerProfile locks in opposite
 * orders and deadlock — releaseQuotaMany owns that ordering, and pays the whole
 * batch in two statements rather than one per firm. One per firm put a batch
 * spanning sixty firms over Prisma's 5 s interactive-transaction timeout, and
 * the `.catch` below then reported a silent zero that the next sweep reproduced
 * exactly. See lib/photographers.ts.
 */
const claimSessions = async (
  sessions: StaleSession[]
): Promise<{ claimed: StaleSession[]; bytesReleased: number }> => {
  const none = { claimed: [] as StaleSession[], bytesReleased: 0 };
  if (sessions.length === 0) return none;
  const ids = sessions.map((session) => session.uploadId);

  const won = await prisma
    .$transaction(async (tx) => {
      /* Prisma.join rather than `= ANY($ids)`, for the reason given in
         lib/upload-charges.ts: one bind parameter per id, no reliance on a JS
         array being mapped to a Postgres text[]. CLAIM_BATCH bounds it at 100. */
      const rows = await tx.$queryRaw<{ uploadId: string; userId: string; bytesCharged: bigint }[]>`
        UPDATE "MultipartSession"
           SET "state" = 'ABORTED', "closedAt" = ${new Date()}
         WHERE "uploadId" IN (${Prisma.join(ids)})
           AND "state" = 'OPEN'
        RETURNING "uploadId", "userId", "bytesCharged"`;
      if (rows.length === 0) return { ids: [] as string[], bytesReleased: 0 };

      const bytesReleased = await releaseQuotaMany(
        rows.map((row) => ({ userId: row.userId, bytes: Number(row.bytesCharged) })),
        tx
      );
      return { ids: rows.map((row) => row.uploadId), bytesReleased };
    })
    // A batch that could not be settled is simply left for the next sweep.
    .catch(() => ({ ids: [] as string[], bytesReleased: 0 }));

  const taken = new Set(won.ids);
  return {
    claimed: sessions.filter((session) => taken.has(session.uploadId)),
    bytesReleased: won.bytesReleased
  };
};

/* Throw away the parts of a session already claimed above.
 *
 * Outside the transaction and best effort. A part left in the bucket costs
 * storage; the quota, which is the scarce thing, was settled by the claim — so
 * this can run after the claim, in parallel with other sessions', and failing
 * costs nothing. */
const discardParts = async (session: StaleSession): Promise<void> => {
  const profile = getProfile(session.purpose === "media" ? "media" : "document");
  if (!profile) return;
  await profile.client
    .send(
      new AbortMultipartUploadCommand({
        Bucket: profile.bucket,
        Key: session.key,
        UploadId: session.uploadId
      })
    )
    .catch(() => {});
};

/* The rows this sweep may settle — selected EXACTLY, by the database, in one
 * query.
 *
 * It used to be a Prisma findMany over a deliberate superset, with `take`
 * applied before a per-row `sweepable()` filter in JavaScript, because the real
 * age bound scales with the row's own fileSize (sessionAgeBoundMs) and Prisma
 * cannot express a per-row comparison. That is not merely wasteful: a row the
 * superset selects and the filter rejects is never settled, stays among the
 * OLDEST open rows, and is therefore re-selected at the head of every subsequent
 * sweep, forever. The rows in question are the ones whose declared size earns
 * them more than the two-day floor — fileSize over ~21.6 GB — that are older
 * than two days and still being kept alive by a `sign` every few hours, which a
 * client stuck in a re-sign retry loop produces by accident and a link holder
 * produces on purpose. The pending tiers cap one firm at ~23 of them, under
 * sweepFirmMultipart's budget of 25, so the per-firm sweep survived; but ~22
 * such firms fill sweepAbandonedMultipart's 500-row budget, after which the
 * daily cron sweeps nothing at all and every other firm's dead-browser bytes
 * stay charged indefinitely.
 *
 * So the exact bound goes into SQL and `take` is spent only on rows that will be
 * settled. The three branches are the same rule as before:
 *
 *   1-2. COALESCE(lastActivityAt, createdAt) < now - inactiveForMs, split so it
 *        can use the (state, lastActivityAt) index. The fallback matters: rows
 *        written before lastActivityAt existed have it null, and createdAt is
 *        the value it would have held.
 *   3.   the age backstop, which exists because lastActivityAt is refreshed by a
 *        call the session's own holder makes. The flat MAX_SESSION_AGE_MS
 *        conjunct is kept beside the per-row one purely so the planner has an
 *        indexable bound on (state, createdAt): the per-row bound is never
 *        smaller, so the conjunct narrows nothing.
 *
 * Both sides of every comparison are naive timestamps: Prisma stores DateTime as
 * TIMESTAMP(3) holding UTC, so "now" has to be `now() AT TIME ZONE 'UTC'`.
 * Plain now() is a timestamptz and would be compared through whatever TimeZone
 * the session happens to carry, which on a 7-hour threshold is not a rounding
 * error. */
const selectStale = (
  userId: string | undefined,
  inactiveForMs: number,
  limit: number
): Promise<StaleSession[]> => {
  const inactive = Math.max(0, inactiveForMs);
  const now = Prisma.sql`(now() AT TIME ZONE 'UTC')`;
  const scope = userId ? Prisma.sql`AND "userId" = ${userId}` : Prisma.empty;

  return prisma.$queryRaw<StaleSession[]>`
    SELECT "uploadId", "userId", "key", "purpose", "bytesCharged", "fileSize",
           "createdAt", "lastActivityAt"
      FROM "MultipartSession"
     WHERE "state" = 'OPEN'
       ${scope}
       AND (
             "lastActivityAt" < ${now} - ${inactive}::double precision * interval '1 millisecond'
          OR ("lastActivityAt" IS NULL
              AND "createdAt" < ${now} - ${inactive}::double precision * interval '1 millisecond')
          OR ("createdAt" < ${now} - ${MAX_SESSION_AGE_MS}::double precision * interval '1 millisecond'
              AND "createdAt" < ${now} - GREATEST(
                    ${MAX_SESSION_AGE_MS}::double precision,
                    "fileSize"::double precision / ${BYTES_PER_MS_AT_1_MBIT}::double precision
                  ) * interval '1 millisecond')
           )
     ORDER BY "createdAt" ASC
     LIMIT ${limit}`;
};

/* Aborts in flight at once. The claims are batched transactions — each holds a
   pooled connection, and a serverless pool is a handful deep — while the
   storage calls, which authorise nothing, go in parallel. That is what keeps a
   500-row sweep inside the cron's 60-second budget, which it shares with the
   charge sweep; the arithmetic is in /api/cron/reminders. */
const DISCARD_CONCURRENCY = 20;

export type MultipartSweep = { swept: number; bytesReleased: number };

/** Select, settle, count. The two public sweeps differ only in scope and budget. */
const runSweep = async (
  userId: string | undefined,
  inactiveForMs: number,
  limit: number
): Promise<MultipartSweep> => {
  const take = Math.max(0, limit);
  if (take === 0) return { swept: 0, bytesReleased: 0 };
  // Oldest first: the ones most certainly dead, and the most expensive to keep.
  const stale = await selectStale(userId, inactiveForMs, take);

  let swept = 0;
  let bytesReleased = 0;
  for (let at = 0; at < stale.length; at += CLAIM_BATCH) {
    const { claimed, bytesReleased: released } = await claimSessions(stale.slice(at, at + CLAIM_BATCH));
    swept += claimed.length;
    bytesReleased += released;

    /* Storage comes after the claim and outside its transaction: the quota,
       which is the scarce thing, is already settled, so these can go wide and
       failing costs nothing but a leftover part. */
    for (let from = 0; from < claimed.length; from += DISCARD_CONCURRENCY) {
      await Promise.all(claimed.slice(from, from + DISCARD_CONCURRENCY).map(discardParts));
    }
  }
  return { swept, bytesReleased };
};

/**
 * Every firm's abandoned sessions. The daily cron job.
 *
 * Switched from "OPEN for more than 7 days" to the inactivity rule, because the
 * inactivity rule is both tighter and better justified: 7 days was a guess made
 * when nothing on the row could prove an upload was dead, and it meant a closed
 * tab's parts were billed for a week. 7 hours of silence is a proof (see
 * INACTIVITY_MS), and the same reasoning covers an employee's session as a
 * photographer's — part signatures live the same six hours for everyone.
 *
 * The old absolute bound was not dropped, only shortened and made proportional:
 * sessionAgeBoundMs takes any OPEN row past max(2 days, the time 1 Mbit/s needs
 * for its declared size) whatever its activity says, because activity is
 * something the session's holder can manufacture and size is not.
 */
export const sweepAbandonedMultipart = (inactiveForMs = INACTIVITY_MS): Promise<MultipartSweep> =>
  runSweep(undefined, inactiveForMs, MAX_PER_SWEEP);

/**
 * One firm's abandoned sessions, run opportunistically when that firm opens a
 * new multipart upload.
 *
 * This is what makes the firm-wide pending-bytes cap fair. The cap sums every
 * OPEN session of the firm — main login and every contributor together — so a
 * dead browser used to hold its share of the ceiling until the daily job came
 * round. Recycling the firm's own dead sessions at the moment it needs the room
 * means the cap only ever has to stop a flood.
 *
 * Deliberately a small limit: this sits on the critical path of starting an
 * upload and each session costs a storage round trip. A firm with more dead
 * sessions than this clears the rest on its next file, or on the daily sweep.
 * The caller is also rate-limited to one pass per firm per minute
 * (claimSweepSlot), so 25 is the most this can cost a firm in a minute however
 * many creates arrive — at DISCARD_CONCURRENCY it is ~2 waves of aborts.
 */
export const sweepFirmMultipart = (userId: string, limit = 25): Promise<MultipartSweep> =>
  runSweep(userId, INACTIVITY_MS, limit);
