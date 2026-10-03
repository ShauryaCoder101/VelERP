import { Prisma } from "@prisma/client";
import { prisma } from "./db";

/* Did anybody's uploads actually land?
 *
 * This exists because of 1 October. A $queryRaw over a void-returning
 * pg_advisory_xact_lock made `complete` throw for EVERY file above the 16 MB
 * single-PUT threshold, so one firm's browser aborted ~290 videos four or five
 * times over while the 396 smaller files in the same folder saved perfectly.
 * Nothing anywhere said so. The firm's own upload dialog showed failures; the
 * ERP showed a growing file count and a quota bar going up, which is exactly
 * what a healthy day looks like. Velocity found out two days later from a voice
 * note.
 *
 * So this reads the two ledgers that already record every attempt and reports,
 * per uploader account, how many got through. It is read-only and aggregated in
 * the database — no row-by-row scan into JS — because it runs inside the daily
 * cron's 60 second budget alongside two sweeps and four reminder emails.
 *
 * The two halves of an upload fail in completely different places, and only one
 * of them is a multipart session, so both are counted:
 *
 *   large files (> MULTIPART_THRESHOLD) leave a MultipartSession row, which is
 *   the authoritative state machine: OPEN -> COMPLETED or OPEN -> ABORTED.
 *
 *   small files leave an UploadCharge row at presign, settled later as
 *   "registered" (the file arrived), "landed" (the object is there but no row
 *   claimed it) or "refunded" (the object is provably absent — the PUT never
 *   happened, or the tab closed between presign and registration).
 *
 * Employees have no quota ceiling and therefore no UploadCharge rows at all, so
 * their small-file figures are structurally zero. That is a real blind spot and
 * not an error: nothing else records a small-file attempt for them. Their large
 * files are covered, because MultipartSession is written for everyone.
 */

/* An ABORTED session is not automatically a failure. The janitor
 * (lib/multipart-janitor.ts) also writes ABORTED when it reclaims a session
 * whose browser tab was simply closed, and that sweep runs no earlier than
 * MAX_INACTIVITY hours after the session was opened. So the two are told apart
 * by how long the row lived: an abort the CLIENT asked for arrives while the
 * upload is still in flight — on 1 October they came back 10 to 60 seconds
 * after create — whereas the janitor's are hours old by construction. Two hours
 * is comfortably inside the janitor's window and comfortably outside any abort
 * a browser issues mid-batch.
 *
 * Long-lived aborts are still counted, separately, as `largeSwept`: "people
 * close tabs" is useful context and must not be read as "uploads are broken". */
const CLIENT_ABORT_WINDOW = Prisma.sql`interval '2 hours'`;

/* One FILE, out of the several sessions one file can now open.
 *
 * lib/media-upload.ts retries a failed file up to MAX_FILE_ATTEMPTS times, and
 * every attempt opens its own MultipartSession and aborts it seconds later —
 * inside CLIENT_ABORT_WINDOW, so each one looked exactly like a lost video. Two
 * separate lies came out of that: a file that failed once and landed on the
 * retry was reported as a failure on a day when everything arrived, and a file
 * that really was lost was counted three times with three times its bytes. So
 * the sessions are folded into files BEFORE anything is counted, and a file
 * counts as failed only if NO attempt at it completed.
 *
 * A file is identified by the key with the "<epochMs>.<nonce>-" stamp
 * buildUploadKey adds stripped off, because a retry mints a fresh key for the
 * same file — same event, same folder, same name. The last segment is isolated
 * first (strpos on the reversed key) so the pattern can be anchored with ^ and
 * cannot reach a folder that happens to look like a stamp. No backslashes: the
 * replacement is empty and the character classes are spelled out, so nothing
 * here depends on how a tagged template treats an escape.
 *
 * The '/' between the folder and the name is KEPT (hence the + 1 — strpos gives
 * the separator's own position from the end, so dropping it is one character
 * too few). Without it "<...>/Day1/<stamp>-x.MP4" and "<...>/Day/<stamp>-1x.MP4"
 * both read as ".../Day1x.MP4": two different videos folded into one file, and
 * the pair then counts as failed only if NEITHER landed — so a lost file hides
 * behind a sibling that saved, which is precisely the silence this module was
 * written to break.
 *
 * It also means two genuinely separate uploads of the same name and size into
 * the same folder inside one window count once. That is a duplicate the skip
 * check exists to prevent, and merging them is the safe direction: the pair is
 * only counted as failed if neither of them landed. */
const FILE_IDENTITY = Prisma.sql`
  left("key", length("key") - strpos(reverse("key"), '/') + 1)
    || regexp_replace(
         right("key", strpos(reverse("key"), '/') - 1),
         '^[0-9]{10,}([.][0-9a-f]{8,16})?-',
         ''
       )`;

/* Thumb and preview slots are charged at presign beside the original. They are
 * generated by the browser and are not what anybody means by "a file", so they
 * would multiply every small-file count by three. Same test registration uses
 * (app/api/uploads/route.ts): the derivative prefix is "/.derived/". */
const ORIGINAL_KEY_ONLY = Prisma.sql`"key" NOT LIKE '%/.derived/%'`;

/* The other half of "why did nobody notice": the Vercel logs said nothing
 * useful either. The 1 October failure threw inside a Prisma transaction, Next
 * rendered it as a 500, and what reached the logs was a deserialization message
 * with no upload, no key and no account attached to it — so even reading them
 * did not point at multipart complete.
 *
 * One line, one shape, greppable: every upload failure path writes through here
 * so a search for "upload-failure" gets all of them and the fields line up.
 *
 * Never the signed URL and never the ticket: both are bearer credentials, and
 * Vercel's logs are not where either belongs. The key is deliberately included —
 * it is an object path, not a credential, and without it a failure cannot be
 * tied to a file. */
export function logUploadFailure(fields: {
  route: string;
  action: string;
  userId: string | null;
  eventId?: string | null;
  key?: string | null;
  uploadId?: string | null;
  error: unknown;
}) {
  const error = fields.error as { name?: string; message?: string } | undefined;
  const parts = [
    "[upload-failure]",
    `route=${fields.route}`,
    `action=${fields.action}`,
    `user=${fields.userId ?? "-"}`,
    `event=${fields.eventId ?? "-"}`,
    `key=${fields.key ?? "-"}`,
    `uploadId=${fields.uploadId ?? "-"}`,
    `error=${error?.name ?? "Error"}: ${error?.message ?? String(fields.error)}`
  ];
  console.error(parts.join(" "));
}

/** One uploader account's figures for the window. */
export type UploadHealthAccount = {
  userId: string;
  name: string;
  /** The firm's photographer UID (TPP-002 and so on), or null for an employee. */
  uid: string | null;
  role: string;
  isPhotographer: boolean;

  /* Large FILES (not sessions — see FILE_IDENTITY) with at least one multipart
     attempt in the window. Each file falls in exactly one of the four buckets
     below, so they sum to largeAttempted. */
  largeAttempted: number;
  largeCompleted: number;
  /** No attempt landed and one was aborted while live — a file actually lost. */
  largeFailed: number;
  /** Aborted by the janitor long afterwards — an abandoned tab, not a failure. */
  largeSwept: number;
  /** Still OPEN. An upload in flight when this ran, or one not yet swept. */
  largeOpen: number;
  /** Bytes of the lost files, counted once each, for "how much was lost". */
  failedBytes: number;
  /** When the most recent client abort closed, or null. */
  lastFailureAt: Date | null;

  /** Small files: original keys presigned in the window. */
  smallPresigned: number;
  smallRegistered: number;
  /** Presigned, refunded, therefore provably never arrived. */
  smallMissing: number;

  /** Upload rows actually written in the window — the bottom line. */
  filesRegistered: number;
};

export type UploadHealth = {
  since: Date;
  accounts: UploadHealthAccount[];
};

/* The alert rules. Deliberately blunt: the question this answers is "is
 * somebody's upload broken right now", and the cost of a false positive is one
 * email to two people.
 *
 * Every figure they are read against counts FILES, not attempts (see
 * FILE_IDENTITY), so "five" means five videos nobody has, not one video the
 * retry layer tried five times, and a file that failed once and landed on the
 * second go is not in the numerator at all.
 *
 * MIN_FAILURES alone catches the 1 October shape (293 failures, 0 successes)
 * and would catch it at file five. The RATE rule catches the slower version —
 * a firm whose videos fail while their stills save — which an absolute count
 * misses on a small shoot. MIN_MISSING_SMALL is deliberately higher: a handful
 * of refunds a day is normal, because closing the tab mid-batch produces them. */
export const ALERT_MIN_FAILURES = 5;
export const ALERT_FAILURE_RATE = 0.25;
export const ALERT_MIN_ATTEMPTS_FOR_RATE = 5;
export const ALERT_MIN_MISSING_SMALL = 20;

export const isUnhealthy = (a: UploadHealthAccount) =>
  a.largeFailed >= ALERT_MIN_FAILURES ||
  (a.largeAttempted >= ALERT_MIN_ATTEMPTS_FOR_RATE &&
    a.largeFailed / a.largeAttempted >= ALERT_FAILURE_RATE) ||
  a.smallMissing >= ALERT_MIN_MISSING_SMALL;

/* One line saying what to look at. The two failure modes have completely
 * different causes, so a single generic sentence would send whoever reads the
 * mail to the wrong place. */
export const healthHint = (a: UploadHealthAccount) => {
  if (a.largeFailed > 0 && a.largeCompleted === 0 && a.largeAttempted >= ALERT_MIN_FAILURES) {
    return "Every large file failed — this looks like the server rejecting the final step, not the connection. Check the /api/uploads/multipart logs.";
  }
  if (a.largeFailed > 0) {
    return "Large files are being cancelled mid-upload. Usually the connection, but confirm against the /api/uploads/multipart logs.";
  }
  return "Files were authorised but never arrived. Check whether the browser is being closed mid-batch, or storage is refusing the PUT.";
};

type LargeRow = {
  userId: string;
  attempted: number;
  completed: number;
  failed: number;
  swept: number;
  open: number;
  failedBytes: bigint | null;
  lastFailureAt: Date | null;
};

type SmallRow = { userId: string; presigned: number; registered: number; missing: number };
type RegisteredRow = { userId: string; files: number };

/**
 * Per-account upload outcomes for the window `since`..now.
 *
 * `userId` narrows every aggregate to one account — what the photographer page
 * wants. Pushed into the SQL rather than filtered afterwards because the page is
 * on a request path and has no business aggregating every firm to show one line.
 *
 * `countRegistered` false drops the Upload aggregate, leaving filesRegistered at
 * zero. It is not an optimisation to sprinkle about: Upload is indexed on
 * (contributorId) and (eventId, fileUrl) and on nothing that starts with
 * uploadedBy or createdAt, so that one query is a sequential scan of the table
 * the whole ERP shares — the exact cost the schema comment on [eventId, fileUrl]
 * was written about. The cron can afford it once a night; a staff page that
 * reloads cannot, and firmUploadHealth therefore counts what landed from the two
 * ledgers that ARE indexed by user. The other aggregates are covered by
 * MultipartSession([userId, state]) and UploadCharge([userId, settledAt]).
 *
 * Read-only. Safe to call from a cron or from a staff page.
 */
export async function computeUploadHealth({
  since,
  userId,
  countRegistered = true
}: {
  since: Date;
  userId?: string;
  countRegistered?: boolean;
}): Promise<UploadHealth> {
  /* The window is expressed as an age, not as a bound timestamp, for the reason
     spelled out in lib/multipart-janitor.ts: Prisma stores DateTime as
     TIMESTAMP(3) holding UTC, so a comparison has to be against
     `now() AT TIME ZONE 'UTC'` rather than a plain now() carrying whatever
     TimeZone the session happens to have. Deriving the cutoff in SQL from one
     millisecond offset keeps every comparison on that same naive-UTC footing.
     Clamped at zero so a future `since` reads as an empty window, not as the
     whole table. */
  const ageMs = Math.max(0, Date.now() - since.getTime());
  const cutoff = Prisma.sql`((now() AT TIME ZONE 'UTC') - ${ageMs}::double precision * interval '1 millisecond')`;

  /* A client abort, in SQL. Used twice in the per-attempt pass below — once
     negated, which is what makes failed + swept cover every ABORTED row.
     closedAt is nullable in the
     model, so the IS NOT NULL is load-bearing rather than decorative: without
     it a null would fall out of both the "failed" and "swept" filters and the
     counts would not add up to `attempted`. */
  const clientAbort = Prisma.sql`
    "state" = 'ABORTED' AND "closedAt" IS NOT NULL
      AND "closedAt" <= "createdAt" + ${CLIENT_ABORT_WINDOW}`;

  /* Two spellings of the same scope: Upload names the column "uploadedBy". */
  const scope = userId ? Prisma.sql`AND "userId" = ${userId}` : Prisma.empty;
  const uploadScope = userId ? Prisma.sql`AND "uploadedBy" = ${userId}` : Prisma.empty;

  const [large, small, registered] = await Promise.all([
    /* Three passes, not one: sessions -> files -> outcomes. The middle step is
       the point — see FILE_IDENTITY — and the third exists only because a SELECT
       list cannot refer to its own aliases. */
    prisma.$queryRaw<LargeRow[]>`
      WITH "attempt" AS (
        SELECT "userId",
               ${FILE_IDENTITY} AS "file",
               "fileSize",
               "closedAt",
               ("state" = 'COMPLETED') AS "completed",
               (${clientAbort}) AS "clientAborted",
               ("state" = 'ABORTED' AND NOT (${clientAbort})) AS "swept",
               ("state" = 'OPEN') AS "open"
          FROM "MultipartSession"
         WHERE "createdAt" >= ${cutoff}
           ${scope}
      ),
      "perFile" AS (
        SELECT "userId",
               -- Part of the grouping, not an aggregate: a retry declares the
               -- same size, and a different size IS a different file.
               "fileSize",
               bool_or("completed") AS "completed",
               bool_or("clientAborted") AS "clientAborted",
               bool_or("swept") AS "swept",
               bool_or("open") AS "open",
               MAX("closedAt") FILTER (WHERE "clientAborted") AS "lastFailureAt"
          FROM "attempt"
         GROUP BY "userId", "file", "fileSize"
      ),
      "outcome" AS (
        SELECT "userId",
               "fileSize",
               "lastFailureAt",
               "completed",
               /* Mutually exclusive and exhaustive, in this order, so the four
                  counts below always add up to "attempted": a landed file is
                  never a failure however many goes it took, and a file with no
                  terminal row left is still in flight. */
               (NOT "completed" AND "clientAborted") AS "lost",
               (NOT "completed" AND NOT "clientAborted" AND "swept") AS "abandoned",
               (NOT "completed" AND NOT "clientAborted" AND NOT "swept" AND "open") AS "inFlight"
          FROM "perFile"
      )
      SELECT "userId",
             COUNT(*)::int AS "attempted",
             COUNT(*) FILTER (WHERE "completed")::int AS "completed",
             COUNT(*) FILTER (WHERE "lost")::int AS "failed",
             COUNT(*) FILTER (WHERE "abandoned")::int AS "swept",
             COUNT(*) FILTER (WHERE "inFlight")::int AS "open",
             -- Cast back to bigint: SUM over bigint is numeric, which Prisma
             -- hands back as a Decimal, and int8 maps cleanly to a JS BigInt.
             COALESCE(SUM("fileSize") FILTER (WHERE "lost"), 0)::bigint AS "failedBytes",
             MAX("lastFailureAt") FILTER (WHERE "lost") AS "lastFailureAt"
        FROM "outcome"
       GROUP BY "userId"`,

    prisma.$queryRaw<SmallRow[]>`
      SELECT "userId",
             COUNT(*)::int AS "presigned",
             COUNT(*) FILTER (WHERE "outcome" = 'registered')::int AS "registered",
             COUNT(*) FILTER (WHERE "outcome" = 'refunded')::int AS "missing"
        FROM "UploadCharge"
       WHERE "createdAt" >= ${cutoff}
         ${scope}
         AND ${ORIGINAL_KEY_ONLY}
       GROUP BY "userId"`,

    // The sequential scan; see countRegistered on the signature.
    countRegistered
      ? prisma.$queryRaw<RegisteredRow[]>`
      SELECT "uploadedBy" AS "userId", COUNT(*)::int AS "files"
        FROM "Upload"
       WHERE "createdAt" >= ${cutoff}
         ${uploadScope}
       GROUP BY "uploadedBy"`
      : Promise.resolve<RegisteredRow[]>([])
  ]);

  const ids = new Set<string>();
  for (const row of large) ids.add(row.userId);
  for (const row of small) ids.add(row.userId);
  for (const row of registered) ids.add(row.userId);
  if (ids.size === 0) return { since, accounts: [] };

  const users = await prisma.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, uid: true, role: true }
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  const largeById = new Map(large.map((r) => [r.userId, r]));
  const smallById = new Map(small.map((r) => [r.userId, r]));
  const registeredById = new Map(registered.map((r) => [r.userId, r]));

  const accounts: UploadHealthAccount[] = [];
  for (const id of ids) {
    const user = byId.get(id);
    /* A deleted account's rows cascade away with it, so this should not happen
       — but a missing user must not drop a failure silently, because an unnamed
       failing account is still a failing account worth mailing about. */
    const l = largeById.get(id);
    const s = smallById.get(id);
    accounts.push({
      userId: id,
      name: user?.name ?? "Unknown account",
      uid: user?.uid ?? null,
      role: user?.role ?? "UNKNOWN",
      isPhotographer: user?.role === "PHOTOGRAPHER",
      largeAttempted: l?.attempted ?? 0,
      largeCompleted: l?.completed ?? 0,
      largeFailed: l?.failed ?? 0,
      largeSwept: l?.swept ?? 0,
      largeOpen: l?.open ?? 0,
      // SUM over bigint comes back as bigint; byte counts here are far inside
      // Number's exact range and every caller wants a number.
      failedBytes: Number(l?.failedBytes ?? 0),
      lastFailureAt: l?.lastFailureAt ?? null,
      smallPresigned: s?.presigned ?? 0,
      smallRegistered: s?.registered ?? 0,
      smallMissing: s?.missing ?? 0,
      filesRegistered: registeredById.get(id)?.files ?? 0
    });
  }

  // Worst first: whoever reads the alert should not have to scan for the row
  // that matters.
  accounts.sort(
    (a, b) => b.largeFailed + b.smallMissing - (a.largeFailed + a.smallMissing)
  );

  return { since, accounts };
}

/** The accounts an alert should be sent about, worst first. */
export const unhealthyAccounts = (health: UploadHealth) => health.accounts.filter(isUnhealthy);

/** The short shape the photographer page shows: one line under the quota bar. */
export type FirmUploadHealth = {
  windowHours: number;
  /** Files that landed in the window: large ones that completed plus small ones
   *  whose charge settled as "registered". Not an Upload row count — see
   *  countRegistered on computeUploadHealth for why this page must not ask for
   *  one — but it answers the same question, and only for a photographer firm,
   *  which is the only thing this page shows. */
  filesUploaded: number;
  largeFailed: number;
  smallMissing: number;
  failedBytes: number;
  lastFailureAt: string | null;
};

/**
 * One firm's figures over the last `windowHours`, for the staff photographer
 * page. Zeroed rather than null when the firm did nothing, so the page always
 * has a line to render and never has to distinguish "quiet" from "unknown".
 */
export async function firmUploadHealth(userId: string, windowHours = 24): Promise<FirmUploadHealth> {
  const since = new Date(Date.now() - windowHours * 3_600_000);
  // No Upload scan on a request path, so "how many landed" is summed from the
  // two indexed ledgers instead. See countRegistered.
  const { accounts } = await computeUploadHealth({ since, userId, countRegistered: false });
  const a = accounts[0];
  return {
    windowHours,
    filesUploaded: (a?.largeCompleted ?? 0) + (a?.smallRegistered ?? 0),
    largeFailed: a?.largeFailed ?? 0,
    smallMissing: a?.smallMissing ?? 0,
    failedBytes: a?.failedBytes ?? 0,
    lastFailureAt: a?.lastFailureAt?.toISOString() ?? null
  };
}
