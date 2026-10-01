import crypto from "crypto";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { getProfile, type StorageProfile } from "./storage";
import { allocateQuota, releaseQuotaMany } from "./photographers";
import { derivativeKeyFor } from "./uploadKey";

/* The ledger behind every quota charge a presign makes.
 *
 * Server-only.
 *
 * /api/uploads/presign has to charge before the object exists. A presigned PUT
 * carries a signed Content-Length, so the size declared there is the size that
 * can actually be uploaded — and signing is the only moment in the whole flow
 * that we control, so it is the only place a 1 TB ceiling can bite. The cost of
 * charging early is that an authorisation nobody spends is indistinguishable
 * from one that was: the bytes were added to allocatedBytes and nothing knew
 * what they were for.
 *
 * While every caller held the firm's own login that was untidy accounting. Open
 * upload links made it an attack: a link is a bearer URL anyone can forward, and
 * presign is cheap, so roughly 62,000 scripted calls declaring 16MB each pin a
 * firm's entire terabyte with not one byte in the bucket, locking the main login
 * and every other photographer of that firm out of every event they hold. The
 * only repair was a hand-written UPDATE against production.
 *
 * So each charge becomes a row, and each row is settled exactly once:
 *
 *   "registered"  /api/uploads recorded the file, and — for a derivative — the
 *                 object is really there. The bytes are real.
 *   "landed"      the sweep found the object in storage although no row claimed
 *                 it. The charge STANDS. Refunding it would mean anyone who
 *                 PUTs and simply never registers uploads for free forever.
 *   "refunded"    the sweep found the object definitively absent and gave the
 *                 bytes back.
 *
 * Employees have no ceiling, are never charged, and get no rows.
 *
 * NOT DONE HERE: retention. Settled rows are never removed, so a sustained
 * flood can add tens of thousands of permanent rows a day to a table with four
 * indexes. The pruning step this wants ("settledAt older than 90 days") is a
 * deleteMany against live data, which this project requires an explicit typed
 * confirmation for (CLAUDE.md), so it is deliberately left for a human to
 * authorise rather than smuggled into a cron job.
 */

/* How long a charge is left alone before the sweep will decide its fate.
 *
 * It MUST exceed the life of the PUT URL the charge paid for, or the sweep could
 * HEAD a key, see nothing, refund — and then the object lands on a URL that was
 * still valid, giving away stored bytes. A photographer's PUT URLs live
 * PHOTOGRAPHER_URL_TTL (15 minutes, see /api/uploads/presign), so 45 minutes is
 * three times the window: by the cutoff no URL issued against this charge can be
 * used, and "absent now" means "absent forever".
 *
 * There is no cost to the margin. A real upload registers within seconds of
 * finishing and is settled then; only abandoned charges ever reach the sweep. */
export const SWEEP_AFTER_MINUTES = 45;

const GiB = 1024 * 1024 * 1024;

/* How much of a firm's quota may sit charged against presigns that have not
 * settled — in THREE tiers for link traffic, plus a separate pool for the
 * firm's own login.
 *
 * The sweep is what reclaims abandoned charges, but it cannot reclaim them
 * faster than SWEEP_AFTER_MINUTES, so a flood inside one 45-minute window would
 * still reach the ceiling. These are the second half of the defence: they cap
 * the damage no matter how fast the calls arrive.
 *
 * Why tiers at all, rather than one firm-wide number? Because the thing being
 * rationed is shared and the people sharing it are not equally trusted:
 *
 *   per contributor (4 GB)  one person at one laptop. Still ~150 unsettled
 *                           26 MB files for someone uploading one at a time,
 *                           each normally settled within seconds.
 *   per link (8 GB)         a link is ONE bearer URL that may have been handed
 *                           to a whole crew. Without this tier, a crew of
 *                           five fresh contributors on one forwarded link
 *                           reaches 20 GB and the firm's other links stop.
 *   all links (20 GB)       everything that arrived through any link.
 *
 * And the firm's main login is checked against its OWN 20 GB and nothing else.
 * It is the firm itself rather than a forwarded URL; making it share a tier with
 * its link holders means an abusing link can 429 the firm out of its own account
 * on the ledger's own ceilings. The two pools together can reach 40 GB — 4% of
 * the 1 TB ceiling — which is the price of that separation.
 *
 * Be precise about what the separation buys, because it is less than it looks:
 * no link can make the main login fail THESE ceilings. It is not "a link can
 * never block the main login". allocateQuota runs first, in the same
 * transaction, and draws on the single shared 1 TB — so link traffic that is
 * comfortably inside every tier above still takes quota the main login then
 * cannot get, and on a firm already holding most of its terabyte the main login
 * sees 403 "Upload limit reached" rather than a 429. What bounds that is the
 * tier itself (20 GB of the 1 TB, reclaimed 45 minutes after it is abandoned),
 * not a reservation: the main login has no reserved slice of the 1 TB.
 *
 * 2.5 contributors fill a link's tier and 2.5 links fill the all-links tier, so
 * no single tier is decorative.
 *
 * All of them are enforced INSIDE the charging transaction, after the
 * allocation has taken the firm's PhotographerProfile row lock — see
 * chargeWithLedger. As separate round trips before the charge they were
 * per-request checks rather than ceilings: 2,000 concurrent presigns all read
 * the same pre-flood total, all passed, and ~54 GB went through in one burst. */
export const MAX_UNSETTLED_PER_CONTRIBUTOR_BYTES = 4 * GiB;
export const MAX_UNSETTLED_PER_LINK_BYTES = 8 * GiB;
export const MAX_UNSETTLED_LINK_BYTES = 20 * GiB;
export const MAX_UNSETTLED_MAIN_BYTES = 20 * GiB;

/* The smallest number of bytes a charge can cost, which is what turns the byte
 * ceilings above into ROW ceilings as well.
 *
 * They ration bytes and nothing rationed rows. presign's size validation accepts
 * 1, so `{fileSize: 1, derivatives: ["thumb","preview"], derivativeSizes: {thumb:
 * 1, preview: 1}}` wrote three rows worth three bytes and no tier could ever
 * fire — a link holder at 10 req/s minted ~108,000 permanent unsettled rows an
 * hour with nothing stored. Reclaim is 25 rows per firm per minute plus 1,000 a
 * day from the cron, and only 45 minutes after creation, so the backlog grew
 * faster than it could ever drain; and every later chargeWithLedger aggregates
 * over it WHILE HOLDING the firm's PhotographerProfile row lock, so the firm's
 * own uploads slow and then time out. That is the outcome the ceilings exist to
 * make impossible, reached through lock-hold time instead of through bytes.
 *
 * _folders.ts caps MediaFolder rows per creator and per link for exactly this
 * reasoning ("identities are free", "rows nothing in this app can delete"); the
 * ledger had only the byte cap.
 *
 * A floor rather than a second COUNT aggregate per tier: it costs no query at
 * all, and it bounds the unsettled rows of each tier at limit / unit —
 * 65,536 for a contributor, 327,680 for all of a firm's links together.
 *
 * 64 KiB is below anything this charges for in practice. The originals are
 * photographs and video; the derivatives are browser-generated JPEGs that run to
 * a few hundred KB (the caps are 2 MB and 8 MB). So a real upload is never
 * rounded up, and a charge that IS rounded up is rounded in the safe direction —
 * the firm is briefly over-charged, never under-charged, and the whole rounded
 * amount is what comes back when the row is refunded. */
export const MIN_CHARGE_BYTES = 64 * 1024;

/** One object a presign is about to sign, and what it costs. */
export type Charge = { key: string; bytes: number };

/** Who the charge is for: always the firm, optionally one of its link holders. */
export type ChargeActor = {
  userId: string;
  eventId: string;
  contributorId: string | null;
  /** The link the contributor came through; null for the firm's main login. */
  linkId: string | null;
};

/* Which ceiling a refusal hit, so the caller can say whose limit it was. The
   uploader can do something about "yours" and about "this link"; they can only
   wait out the other two, and the difference is worth telling them. */
export type UnsettledTier = "contributor" | "link" | "links" | "main";

/* Presign charges only ever happen for photographers, who are confined to
   purpose "media" by presign and by multipart create alike. So the sweep knows
   which bucket to look in without storing it on the row. */
const mediaProfile = () => getProfile("media");

const isNotFound = (error: unknown) =>
  (error as { name?: string }).name === "NotFound" ||
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;

type Presence = "present" | "absent" | "unknown";

/* Is this object in the bucket?
 *
 * "unknown" is storage failing to answer, and it is NOT "absent". Treating
 * "could not ask" as "absent" is how a refund gets paid for bytes that are
 * sitting in the bucket. The SDK throws on a 404, so a definite absence arrives
 * as an exception too; only that one is an answer. */
const presenceOf = async (profile: StorageProfile, key: string): Promise<Presence> => {
  try {
    await profile.client.send(new HeadObjectCommand({ Bucket: profile.bucket, Key: key }));
    return "present";
  } catch (error) {
    return isNotFound(error) ? "absent" : "unknown";
  }
};

/* Thrown to roll the charging transaction back when an unsettled ceiling is
   breached. The allocation and the rows are already written at that point and
   both have to disappear together, which only a rollback does. */
class UnsettledCeiling extends Error {
  constructor(readonly tier: UnsettledTier) {
    super("unsettled ceiling");
  }
}

export type ChargeResult =
  | { ok: true; chargeIds: string[] }
  | { ok: false; reason: "quota"; usedBytes: number; quotaBytes: number }
  | { ok: false; reason: "unsettled"; tier: UnsettledTier };

/**
 * Charge a firm for the objects a presign is about to sign, and record what for.
 *
 * ONE transaction, and it does three things that must not come apart:
 *
 *  1. allocates the bytes (the conditional UPDATE that enforces the 1 TB
 *     ceiling, which also takes this firm's PhotographerProfile row lock);
 *  2. writes the ledger rows that explain the allocation;
 *  3. re-measures every unsettled tier this actor is held to, and rolls the
 *     whole thing back if any of them is past.
 *
 * (1) and (2) have to commit together: a crash after the UPDATE leaves bytes
 * charged with nothing that could ever find them again, and a crash after the
 * rows leaves rows the sweep would refund bytes for that were never taken.
 *
 * (3) belongs here rather than in the caller because the row lock from (1) is
 * what makes it a ceiling at all. Every charging transaction takes that lock
 * before it reads, so the firm's charges are serialised: a concurrent presign
 * is still blocked inside allocateQuota when this one aggregates, and when it
 * unblocks it sees these rows committed. Read outside the transaction instead —
 * as this used to be — and N simultaneous requests all see the same pre-flood
 * total and all charge, which is how 2,000 concurrent 26 MB presigns authorised
 * ~54 GB against a 20 GB cap. No new lock and no new column: the serialisation
 * was already there, the read just had to move inside it.
 *
 * Returns the ids of the rows it wrote, so a caller that then fails can settle
 * exactly those rows rather than reaching for releaseQuota directly — see
 * refundCharges.
 */
export const chargeWithLedger = async (actor: ChargeActor, charges: Charge[]): Promise<ChargeResult> => {
  const rows = charges
    .filter((charge) => charge.bytes > 0)
    .map((charge) => ({
      id: crypto.randomUUID(),
      userId: actor.userId,
      eventId: actor.eventId,
      contributorId: actor.contributorId,
      linkId: actor.linkId,
      key: charge.key,
      /* Floored at MIN_CHARGE_BYTES, which is what makes the tiers below a
         ceiling on the NUMBER of unsettled rows as well as on their bytes. A
         1-byte declaration costs the ledger a row either way, and a row is the
         expensive part. */
      bytes: BigInt(Math.max(Math.floor(charge.bytes), MIN_CHARGE_BYTES))
    }));

  const total = rows.reduce((sum, row) => sum + Number(row.bytes), 0);
  if (total === 0) return { ok: true, chargeIds: [] };

  /* Cheapest tier first, so an actor that is over several of them is told about
     the one closest to home — the one they can actually do something about —
     and so the common refusal costs one aggregate rather than four. */
  const tiers: { tier: UnsettledTier; limit: number }[] = actor.contributorId
    ? [
        { tier: "contributor", limit: MAX_UNSETTLED_PER_CONTRIBUTOR_BYTES },
        { tier: "link", limit: MAX_UNSETTLED_PER_LINK_BYTES },
        { tier: "links", limit: MAX_UNSETTLED_LINK_BYTES }
      ]
    : // The firm's own login: its own pool, and nothing a link holder does.
      [{ tier: "main", limit: MAX_UNSETTLED_MAIN_BYTES }];

  try {
    return await prisma.$transaction(async (tx): Promise<ChargeResult> => {
      const quota = await allocateQuota(actor.userId, total, tx);
      if (!quota.ok) return { ...quota, reason: "quota" };
      await tx.uploadCharge.createMany({ data: rows });

      // Includes the rows just written, so each ceiling is a ceiling on the
      // total after this charge rather than before it.
      for (const { tier, limit } of tiers) {
        if ((await unsettledBytes(actor, tier, tx)) > limit) throw new UnsettledCeiling(tier);
      }

      return { ok: true, chargeIds: rows.map((row) => row.id) };
    });
  } catch (error) {
    if (error instanceof UnsettledCeiling) return { ok: false, reason: "unsettled", tier: error.tier };
    throw error;
  }
};

/**
 * Give back charges for objects that will now never be written — a signing
 * failure inside presign, which has already taken the bytes.
 *
 * Goes through the same claim the sweep uses rather than calling releaseQuota
 * directly, because both can be looking at the same row: without the claim a
 * presign that failed at 44 minutes and a sweep that started at 45 would each
 * pay the refund, and the firm's usage would drift DOWN by the same bytes twice.
 */
export const refundCharges = async (chargeIds: string[]): Promise<void> => {
  await claimAndRefund(chargeIds);
};

/**
 * Settle the charges for a file that has just been registered: the original's
 * key, and each derivative key whose object is really in the bucket.
 *
 * Conditional on settledAt IS NULL, so it can never overwrite a settlement the
 * sweep already made — if the sweep refunded a charge first, registration must
 * not quietly re-charge it by stamping "registered" over the top.
 *
 * The derivatives are CHECKED, not assumed. A thumbnail is best effort in the
 * client (lib/media-upload.ts counts the failures and carries on), so a slot
 * that was charged may hold nothing at all — and settling it "registered" is
 * the one outcome from which the bytes never come back. At 10 MB of slots per
 * file, a shoot whose browser could not decode its raw files pays for a few
 * thousand thumbnails that do not exist.
 *
 * The two HEADs go in parallel and cost one round trip of wall clock on a path
 * that has just finished uploading the whole file, so the old objection to this
 * ("two thousand round trips on a thousand-file shoot") was really an objection
 * to doing them in series.
 *
 * A derivative that is absent — or that storage would not answer for — is left
 * UNSETTLED rather than refunded here. Registration is not the place that
 * decides a key is empty forever: the PUT URL for that slot may still be live.
 * The sweep owns that decision, HEADs the key again after SWEEP_AFTER_MINUTES,
 * and refunds only then. The signed Content-Length is what makes the kept
 * charges exact: a derivative that IS present holds precisely the number of
 * bytes its charge declared, no more.
 */
export const settleRegistered = async (userId: string, key: string): Promise<number> => {
  const profile = mediaProfile();
  const derivatives = (["thumb", "preview"] as const).map((kind) => derivativeKeyFor(key, kind));

  /* Without a bucket there is nothing to ask. Settle the original only and let
     the sweep deal with the derivative rows; guessing "present" here is the one
     answer that cannot be taken back. */
  const present = profile
    ? (await Promise.all(derivatives.map((dKey) => presenceOf(profile, dKey))))
        .map((presence, at) => (presence === "present" ? derivatives[at] : null))
        .filter((dKey): dKey is string => dKey !== null)
    : [];

  const settled = await prisma.uploadCharge.updateMany({
    where: { userId, key: { in: [key, ...present] }, settledAt: null },
    data: { settledAt: new Date(), outcome: "registered" }
  });
  return settled.count;
};

/* Bytes this firm — or one of its contributors, or one of its links — has
   charged that nothing has accounted for yet.

   `db` so it can be read inside the charging transaction, which is the only
   place the number is a ceiling rather than a snapshot (see chargeWithLedger).

   "links" is every row that arrived through ANY link; "main" is every row that
   did not, which is the firm's own login. The two partition the firm's
   unsettled rows, which is what keeps the main login's pool its own. */
export const unsettledBytes = async (
  actor: Pick<ChargeActor, "userId" | "contributorId" | "linkId">,
  tier: UnsettledTier,
  db: Pick<typeof prisma, "uploadCharge"> = prisma
): Promise<number> => {
  const scope =
    tier === "contributor"
      ? { contributorId: actor.contributorId }
      : tier === "link"
        ? { linkId: actor.linkId }
        : tier === "links"
          ? { linkId: { not: null } }
          : { contributorId: null };

  const sum = await db.uploadCharge.aggregate({
    where: { userId: actor.userId, settledAt: null, ...scope },
    _sum: { bytes: true }
  });
  return Number(sum._sum.bytes ?? 0n);
};

/* Claim a BATCH of rows, then refund — in ONE transaction.
 *
 * The claim is the conditional update null -> now(), and RETURNING is what
 * makes it a claim rather than a read followed by a write: Postgres returns
 * exactly the rows this statement moved, so the refund is computed from the
 * bytes this writer won and nothing else. Exactly one writer can win a row:
 *
 *   - a concurrent SECOND SWEEP touching the same row blocks on its row lock,
 *     then re-evaluates "settledAt IS NULL", fails it, and returns that row to
 *     nobody — it pays nothing and moves on;
 *   - a concurrent REGISTRATION settling the same key is the same conditional
 *     update on the same row, so one of the two wins and the other is a no-op.
 *     Registration winning is the ordinary case and the charge stands;
 *   - a crash between claiming and refunding is impossible to observe, because
 *     a transaction that did not commit leaves the rows unsettled and the next
 *     sweep tries again.
 *
 * Batched because the per-row version was a transaction, and therefore a pooled
 * connection and a round trip, for every single row: a 1000-row cron sweep was
 * 1000 transactions. One statement settles up to CLAIM_BATCH of them and
 * releaseQuotaMany pays every firm in the batch in two more — NOT one per firm,
 * which would put a batch spanning sixty firms over Prisma's 5 s interactive
 * transaction timeout and turn the whole refund into a silent "refunded: 0"
 * that the next sweep reproduces exactly. See lib/photographers.ts.
 *
 * The refunds are applied in sorted user order so that two sweeps holding
 * overlapping sets of firms cannot deadlock on the PhotographerProfile rows by
 * taking them in opposite orders. (Against chargeWithLedger there is no cycle
 * to begin with: it takes the profile lock first and only ever INSERTs charge
 * rows, and a plain aggregate does not wait on a locked row.)
 *
 * Could registration lose and leave a registered file refunded? It would need
 * the object to be absent when the sweep HEADs it and present when registration
 * HEADs it (/api/uploads refuses to record a file storage cannot confirm). The
 * only thing that could put it there is a PUT on the URL this charge paid for,
 * and that URL expired 30 minutes before the cutoff. So no.
 */
const claimAndRefund = async (ids: string[]): Promise<{ rows: number; bytes: number }> => {
  const none = { rows: 0, bytes: 0 };
  if (ids.length === 0) return none;

  return prisma
    .$transaction(async (tx) => {
      /* Prisma.join rather than `= ANY($ids)`: it expands to one bind
         parameter per id, which every driver in this project is already known
         to handle, instead of relying on a JS array being mapped to a Postgres
         text[]. The two are the same query to the planner. CLAIM_BATCH keeps
         the parameter count at 100, nowhere near Postgres's 65,535. */
      const claimed = await tx.$queryRaw<{ userId: string; bytes: bigint }[]>`
        UPDATE "UploadCharge"
           SET "settledAt" = ${new Date()}, "outcome" = 'refunded'
         WHERE "id" IN (${Prisma.join(ids)})
           AND "settledAt" IS NULL
        RETURNING "userId", "bytes"`;
      if (claimed.length === 0) return none;

      const bytes = await releaseQuotaMany(
        claimed.map((row) => ({ userId: row.userId, bytes: Number(row.bytes) })),
        tx
      );
      return { rows: claimed.length, bytes };
    })
    // A batch that could not be settled is simply left for the next sweep —
    // including a deadlock, which Postgres resolves by killing one side.
    .catch(() => none);
};

/* Settle rows whose object really is in the bucket. One statement, and
   conditional for the same reason the refund is: registration may have got
   there first, and "registered" and "landed" both keep the charge, so whoever
   wins is right. */
const claimLanded = async (ids: string[]): Promise<number> => {
  if (ids.length === 0) return 0;
  const settled = await prisma.uploadCharge
    .updateMany({
      where: { id: { in: ids }, settledAt: null },
      data: { settledAt: new Date(), outcome: "landed" }
    })
    .catch(() => ({ count: 0 }));
  return settled.count;
};

export type SweepResult = { checked: number; landed: number; refunded: number; bytesReleased: number };

/* How many HEADs are in the air at once.
 *
 * One row was one round trip, strictly in series: at ~100ms a presign's budget
 * of 25 rows cost 2.5 seconds on an uploader's critical path, and the cron —
 * maxDuration 60s, shared with the multipart janitor — drained a backlog far
 * more slowly than a flood could create it.
 *
 * Twenty at a time is what makes the cron's budget fit; the arithmetic is in
 * /api/cron/reminders. It is well inside the SDK's default socket pool (50) and
 * the HEADs authorise nothing, so a wave that partly fails costs only the rows
 * that failed — they stay unsettled and are swept next time. */
const HEAD_CONCURRENCY = 20;

/* How many rows one settling transaction covers.
 *
 * The settlements no longer happen per row, but they must not wait for the
 * whole sweep either: a 1000-row pass that dies at row 900 — the cron's 60s
 * budget expiring is the ordinary way — would otherwise have settled nothing.
 * Flushing every 100 rows bounds the loss to the last partial batch and still
 * collapses a 1000-row sweep to ~20 transactions. */
const CLAIM_BATCH = 100;

/**
 * Decide the fate of charges nobody settled.
 *
 * `userId` scopes it to one firm (the opportunistic sweep presign runs); omitted,
 * it covers every firm (the daily cron). `limit` is a budget, not a target —
 * whatever is left over is swept on the next pass, because this is housekeeping
 * and each row costs a storage round trip (HEAD_CONCURRENCY of them at a time).
 *
 * A storage error that is not a definite 404 leaves the row alone. Treating
 * "could not ask" as "absent" is how a refund gets paid for bytes that are
 * sitting in the bucket.
 */
export const sweepCharges = async ({
  userId,
  olderThanMinutes = SWEEP_AFTER_MINUTES,
  limit = 200
}: {
  userId?: string;
  olderThanMinutes?: number;
  limit?: number;
}): Promise<SweepResult> => {
  const result: SweepResult = { checked: 0, landed: 0, refunded: 0, bytesReleased: 0 };

  const profile = mediaProfile();
  // Without a bucket there is nothing to ask, and guessing is not an option.
  if (!profile) return result;

  const cutoff = new Date(Date.now() - Math.max(0, olderThanMinutes) * 60_000);
  const stale = await prisma.uploadCharge.findMany({
    where: { settledAt: null, createdAt: { lt: cutoff }, ...(userId ? { userId } : {}) },
    // Oldest first: the ones most certainly abandoned.
    orderBy: { createdAt: "asc" },
    take: Math.max(0, limit),
    /* Only the id and the key: the bytes and the owner come back from the
       claim's RETURNING, which is the only place they can be read without
       racing the writer that settles the row. */
    select: { id: true, key: true }
  });

  /* Accumulated across HEAD waves and flushed in batches, so one transaction
     covers many rows without the whole sweep riding on a single commit. */
  const absent: string[] = [];
  const present: string[] = [];

  const flush = async (force: boolean) => {
    if (absent.length >= CLAIM_BATCH || (force && absent.length > 0)) {
      const refunded = await claimAndRefund(absent.splice(0, absent.length));
      result.refunded += refunded.rows;
      result.bytesReleased += refunded.bytes;
    }
    if (present.length >= CLAIM_BATCH || (force && present.length > 0)) {
      result.landed += await claimLanded(present.splice(0, present.length));
    }
  };

  for (let at = 0; at < stale.length; at += HEAD_CONCURRENCY) {
    const wave = stale.slice(at, at + HEAD_CONCURRENCY);
    const presence = await Promise.all(wave.map((row) => presenceOf(profile, row.key)));

    for (let i = 0; i < wave.length; i += 1) {
      // "unknown" is storage not answering: the row waits for the next sweep.
      if (presence[i] === "unknown") continue;
      result.checked += 1;
      /* "present" means the bytes really are in the bucket, so they are really
         being billed. Settle and KEEP the charge — see the "landed" note at the
         top of this file. */
      (presence[i] === "present" ? present : absent).push(wave[i].id);
    }

    await flush(false);
  }

  await flush(true);
  return result;
};
