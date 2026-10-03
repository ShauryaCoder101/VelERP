/* One file, browser to gallery — the whole pipeline in one call.
 *
 * This was the body of app/tpp-login/upload/page.tsx's uploadOne(). It moved
 * here when open upload links arrived: the public /upload/<token> page runs the
 * identical sequence, and the only difference between the two is that a
 * contributor has no session cookie and carries link headers instead. Two
 * copies of "shrink, presign, put the derivatives first, then the original,
 * then register" would drift, and the drift would be invisible — a thumbnail
 * that silently stops being written on one of the two screens.
 *
 * Everything that made the original version correct is preserved deliberately:
 *   - derivatives are generated BEFORE presign, because presign has to declare
 *     each slot's exact byte length (it is signed into the URL);
 *   - derivatives are uploaded BEFORE the original. The reason given here used
 *     to be "their PUT URLs live one hour", which is the EMPLOYEE figure; a
 *     photographer's presigned PUTs live fifteen minutes (PHOTOGRAPHER_URL_TTL
 *     in /api/uploads/presign, shortened to cut the replay window on a bearer
 *     link). The ordering holds a fortiori. One presign call signs all three
 *     slots at the same moment, so all three windows start together: the two
 *     derivatives are a few hundred KB and land in seconds, while a multi-GB
 *     original takes far longer than fifteen minutes — on the multipart path it
 *     is not even using these URLs, since its parts are signed separately with
 *     a six-hour life. Sending the small ones first spends the short window on
 *     the only objects that fit in it; sending them last means uploading them
 *     against URLs that expired while the original was still going;
 *   - and since /api/uploads now HEADs the two derivative keys before it will
 *     settle their charges as "registered", the ordering is load-bearing for
 *     the accounting too: a derivative that has not landed by the time the
 *     original is registered is left unsettled and refunded by the sweep;
 *   - a failed derivative is counted, never fatal;
 *   - the reservation from presign is handed to the multipart route, so the
 *     original lands on the key the derivatives were signed against;
 *   - the server's own error message is what surfaces ("Upload limit reached"),
 *     because it is the one that tells the uploader what to do next.
 *
 * `headers` is the only seam for the link case. Every request made here sends
 * it, so authorising a contributor is one object passed in rather than a second
 * code path.
 */

import {
  errorFlag,
  isCancellation,
  statusOfError,
  uploadFile,
  UploadRequestError,
  waitUnlessCancelled
} from "./upload-client";
import { makeDerivatives } from "./derivatives";
import { sanitizeSegment, splitFolderSegments } from "./uploadKey";

/** The server's prefix when a firm has run out of its 1 TB. */
export const QUOTA_MESSAGE = "Upload limit reached";

/**
 * Should the whole batch stop here?
 *
 * Two different refusals say "every remaining file will fail exactly the same
 * way", and neither is about the file in hand:
 *
 *   403 "Upload limit reached" — the firm's 1 TB is full. Nothing the uploader
 *       does will change that today.
 *   429 — one of the in-progress ceilings: too many bytes held by presigns
 *       nobody spent, or by multipart uploads nobody finished, for this
 *       contributor, this link, every link of the firm, or the firm's own
 *       login. These DO clear on their own, but not within the seconds it
 *       takes to try the next file — so grinding through four thousand files
 *       to collect four thousand identical errors helps nobody, and each
 *       attempt is another presign for the ceiling to measure.
 *
 * Recognised by STATUS, not by matching the server's prose: there are now
 * several ceilings with several wordings, and a client that greps for them is
 * a rule that breaks the next time one is reworded, silently and in the
 * direction of hammering the server. The caller shows the server's message.
 *
 * The status alone is not enough, though: the number 429 means two unrelated
 * things on this path. From Velocity's api it is a ceiling and the batch must
 * stop. From R2 it is "throw that part at me again in a moment" — which is
 * exactly how retryableStorageStatus treats it — and reading one of those as a
 * full allowance stopped a 290-file batch on a single throttled part, put the
 * other 287 videos back to "queued" and told the firm its terabyte was full.
 * So a ceiling has to come from our own api, which is what `fromApi` marks.
 *
 * Takes the error rather than its message so the status survives; a bare
 * string still works, for the quota case, so older call sites are not wrong.
 */
export const isQuotaError = (error: unknown): boolean => {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (message.startsWith(QUOTA_MESSAGE)) return true;
  return statusOfError(error) === 429 && errorFlag(error, "fromApi");
};

/* The browser must send exactly the Content-Type the URL was signed for, or
   storage rejects the PUT. Some cameras hand us files with an empty type, so
   both sides agree on this fallback. */
export const contentTypeOf = (file: File) => file.type || "application/octet-stream";

/** The Upload row /api/uploads created (or found, when this file was already registered). */
export type RegisteredUpload = {
  id: string;
  eventId: string;
  fileUrl: string;
  fileType: string | null;
  sizeBytes: number | null;
};

export type MediaUploadResult = {
  upload: RegisteredUpload;
  /** Where the original actually landed. */
  fileUrl: string;
  /* Derivatives (thumb/preview) that did not land. Never fatal — the gallery
     falls back to the original — but returned rather than swallowed so a
     systematic failure is something the caller can say out loud. */
  derivativeFailures: number;
};

export type MediaUploadOpts = {
  file: File;
  eventId: string;
  /** Folder portion only ("Day 1/Stage"), empty for a loose file. RELATIVE TO THE
   *  CALLER'S uploadRoot — the server prepends the firm (and contributor) folder. */
  relativePath: string;
  /** Link credentials for a caller with no session; omitted for a signed-in user. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  onProgress?: (pct: number) => void;
};

const jsonHeaders = (extra?: Record<string, string>) => ({
  "Content-Type": "application/json",
  ...extra
});

/** Posts JSON and surfaces the server's own message on a failure. */
const post = async (
  url: string,
  body: unknown,
  headers: Record<string, string> | undefined,
  fallback: string,
  signal?: AbortSignal
) => {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: jsonHeaders(headers),
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    /* A request that never reached the server rejects with a bare TypeError
       whose message differs per browser. Given status 0 here so everything
       above classifies failures by number rather than by prose. A cancel is
       passed through: it is not a failure and is never retried. */
    if (isCancellation(error)) throw error;
    throw new UploadRequestError("Lost connection to Velocity", 0);
  }
  if (!res.ok) {
    /* The status rides with the message: it is what tells a batch that this
       refusal is a ceiling every remaining file would hit too. */
    const said = await res.json().catch(() => null);
    throw new UploadRequestError(said?.error || fallback, res.status);
  }
  return res.json();
};

/* Registration gets retries of its OWN, before the file-level ones.
 *
 * This is the step that broke on 1 October, and it is the worst possible place
 * to answer by starting the file again: the bytes are already in storage by
 * now. A second attempt at the whole file would upload a 40 GB video twice,
 * charge the firm for both copies — the sweep settles any key whose object
 * exists as "landed", so the orphan is never refunded — and leave one of them
 * with no row pointing at it.
 *
 * Retrying just this POST costs one request and cannot double-register: the
 * route is idempotent on (eventId, fileUrl) and returns the existing row.
 *
 * Four goes rather than three because this is now the ONLY retry this step
 * gets: what escapes here is wrapped in RegistrationFailure, which the
 * file-level layer refuses to restart, so the choice is between asking this
 * endpoint again and losing a file that is already in the bucket.
 *
 * isRetryableUploadError is defined further down, with the rest of the retry
 * layer; it is only called at runtime. */
const REGISTER_ATTEMPTS = 4;
const REGISTER_BACKOFF_MS = [1_000, 4_000, 10_000];

/**
 * Everything /api/uploads needs to record a file whose bytes are already in
 * storage: the exact body the failed POST carried.
 *
 * Carried on the failure so a page can offer "Retry" and have it re-run the
 * REGISTRATION alone — one POST — instead of sending a 40 GB video we are
 * already holding. It is the posted body rather than the File, deliberately:
 * the key is already decided, so a retry must reuse the fileUrl the bytes
 * landed on and must not presign a second one.
 *
 * No headers. A contributor's link credentials are a bearer token, and the two
 * pages already hold theirs; copying them onto an error object would scatter
 * them through console logs and error reporters for nothing.
 */
export type PendingRegistration = {
  eventId: string;
  fileUrl: string;
  fileType: string;
};

/**
 * The registration a failure left outstanding, or null if there is none.
 *
 * Duck-typed for the same reason errorFlag is: a failure reaches a page wrapped
 * in UploadFailure, which copies this across rather than preserving the class.
 * The fields are checked rather than trusted, because what this answers decides
 * whether a retry skips the upload entirely.
 */
export const pendingRegistration = (error: unknown): PendingRegistration | null => {
  const found = (error as { pending?: unknown } | null | undefined)?.pending;
  if (!found || typeof found !== "object") return null;
  const { eventId, fileUrl, fileType } = found as Record<string, unknown>;
  return typeof eventId === "string" && typeof fileUrl === "string" && typeof fileType === "string"
    ? { eventId, fileUrl, fileType }
    : null;
};

/**
 * Registration failed for good — and the file's bytes are already in storage.
 *
 * Its own class because of what must NOT happen next. The underlying error is
 * usually a status 0 or a 5xx, which is precisely the shape
 * isRetryableUploadError says to try again, and "try again" here means
 * re-uploading the whole object under a new key: the firm pays twice, the first
 * copy is settled as "landed" and never refunded, and the gallery still shows
 * one file. `bytesLanded` is the flag that stops that, and it is carried on the
 * error rather than decided at the call site so the wrapper above (UploadFailure)
 * can pass it through unchanged.
 *
 * Status and message stay the underlying error's, so a row still says what went
 * wrong and isQuotaError still answers correctly.
 *
 * `pending` is the other half of that promise: knowing the bytes landed is only
 * useful if the thing that did not happen can still be made to happen, so the
 * body of the POST that failed rides along and a page can retry just it.
 */
export class RegistrationFailure extends Error {
  readonly status: number | null;
  readonly fromApi: boolean;
  /** Read by isRetryableUploadError: never start this file over. */
  readonly bytesLanded = true;
  /** What is left to do: one POST, with this exact body. */
  readonly pending: PendingRegistration;
  readonly cause: unknown;

  constructor(cause: unknown, pending: PendingRegistration) {
    super(messageOf(cause));
    this.name = "RegistrationFailure";
    this.status = statusOfError(cause);
    this.fromApi = errorFlag(cause, "fromApi");
    this.pending = pending;
    this.cause = cause;
  }
}

/**
 * Records a file whose bytes are already in storage, with retries of its own.
 *
 * Exported because it is also the whole of "Retry" for a row that failed HERE:
 * the pages call it directly with the PendingRegistration the failure carried
 * and their own headers, which re-runs the one step that did not finish. Safe to
 * call again with the same body — /api/uploads is idempotent on
 * (eventId, fileUrl) and returns the row it already has.
 */
export const registerUpload = async (
  body: PendingRegistration,
  headers: Record<string, string> | undefined,
  signal?: AbortSignal
): Promise<RegisteredUpload> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await post("/api/uploads", body, headers, "Uploaded, but could not be recorded", signal);
    } catch (error) {
      // A cancel is the uploader's decision, not a failure to dress up.
      if (isCancellation(error)) throw error;
      if (attempt >= REGISTER_ATTEMPTS || !isRetryableUploadError(error)) {
        throw new RegistrationFailure(error, body);
      }
      await waitUnlessCancelled(
        withJitter(REGISTER_BACKOFF_MS[Math.min(attempt, REGISTER_BACKOFF_MS.length) - 1]),
        signal
      );
    }
  }
};

/** Uploads one file end to end and returns the Upload row it was registered as. */
export const uploadMediaFile = async ({
  file,
  eventId,
  relativePath,
  headers,
  signal,
  onProgress
}: MediaUploadOpts): Promise<MediaUploadResult> => {
  /* Shrink first, in the browser: the presign call has to declare the exact
     size of every slot it asks for, including the derivatives, because those
     URLs carry a signed Content-Length. */
  const small = await makeDerivatives(file);
  const wanted = (["thumb", "preview"] as const).filter((kind) => small[kind]);

  const {
    uploadUrl,
    fileUrl: simpleUrl,
    reservation,
    derivatives
  }: {
    uploadUrl?: string;
    fileUrl?: string;
    reservation?: string;
    derivatives?: Record<string, { uploadUrl: string; fileUrl: string }>;
  } = await post(
    "/api/uploads/presign",
    {
      eventId,
      fileName: file.name,
      fileType: contentTypeOf(file),
      relativePath,
      purpose: "media",
      fileSize: file.size,
      derivatives: wanted,
      derivativeSizes: Object.fromEntries(wanted.map((kind) => [kind, small[kind]!.size]))
    },
    headers,
    "Could not get an upload link",
    signal
  );

  /* The derivatives go up FIRST, before the original — see the header comment.
     Still best effort: a missing thumbnail only means the gallery falls back to
     the original and must not fail the file. */
  let derivativeFailures = 0;
  await Promise.all(
    wanted.map(async (kind) => {
      const slot = derivatives?.[kind];
      if (!slot) return;
      try {
        const res = await fetch(slot.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          body: small[kind]!,
          signal
        });
        if (!res.ok) throw new Error(`storage returned ${res.status}`);
      } catch (err) {
        derivativeFailures += 1;
        console.warn(`Could not upload the ${kind} for ${file.name}`, err);
      }
    })
  );

  /* Anything large comes back without a single-PUT slot and goes up in parts,
     so a dropped connection costs one chunk rather than the whole file.

     The reservation goes with it: presign already signed the thumb and preview
     slots against one key, and the multipart route has to write the original to
     that same key or the derivatives above belong to nothing. */
  const fileUrl = await uploadFile(
    file,
    {
      eventId,
      relativePath,
      purpose: "media",
      presignedUrl: uploadUrl,
      fileUrl: simpleUrl,
      reservation,
      headers,
      signal
    },
    (pct) => onProgress?.(pct)
  );

  const upload = await registerUpload(
    { eventId, fileUrl, fileType: contentTypeOf(file) },
    headers,
    signal
  );

  return { upload, fileUrl, derivativeFailures };
};

/* ─────────────────────────────────────────────────────────────────────────
   Trying a file again
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Attempts per file, the first one included.
 *
 * Three, not more. A 40 GB video that fails three times over a hotel
 * connection is not going to succeed on the fourth, and every attempt at a
 * large file costs a fresh presign (and so a fresh reservation against the
 * firm's ceiling) before it can even start.
 */
export const MAX_FILE_ATTEMPTS = 3;

/** Waited before attempt 2, then before attempt 3. */
const BACKOFF_MS = [2_000, 8_000];

/* ±25%. When a connection drops it drops for the whole batch, so without this
   every file in flight would come back at the same instant and the recovery
   would look exactly like the outage to the server. */
const withJitter = (ms: number) => Math.round(ms * (0.75 + Math.random() * 0.5));

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "Upload failed";

/**
 * Is starting this file over worth doing?
 *
 * Decided by status, never by the server's prose — same reasoning as
 * isQuotaError. Status 0 is "the request never arrived", which is the dropped
 * connection this exists for; 408 and every 5xx are "ask again". Anything else
 * is a decision about THIS request that will be made identically next time:
 * a closed link (404/410), a withdrawn grant, a file storage refuses, a quota.
 *
 * An error carrying no status at all is NOT retried. Those are the bugs and the
 * misconfigurations — a missing ExposeHeaders on the bucket, a derivative
 * encoder throwing — and three goes at one is three times the wait before
 * anybody is told what is actually wrong.
 */
export const isRetryableUploadError = (error: unknown): boolean => {
  if (isCancellation(error)) return false;
  /* The bytes are in storage already and only the Upload row is missing. Another
     go would re-upload the object, not re-record it — see RegistrationFailure. */
  if (errorFlag(error, "bytesLanded")) return false;
  /* The ceilings stop the whole batch a moment later; a retry here is a request
     made in order to be refused, and each one is another presign for the
     ceiling to measure. */
  if (isQuotaError(error)) return false;
  const status = statusOfError(error);
  if (status === null) return false;
  /* 429 reaches here only from STORAGE — our api's 429s are ceilings and left
     above — and it means "that part again in a moment", which after four tries
     inside the part loop is worth one more go at the file. */
  return status === 0 || status === 408 || status === 429 || status >= 500;
};

/**
 * A file that failed every attempt, remembering how many there were.
 *
 * Deliberately transparent: the message, the status and the markers are the
 * underlying error's, so isQuotaError, statusOfError, errorFlag and
 * `err.message` all behave exactly as they did before the retry layer existed.
 * Copying the markers across is what keeps that promise — a page classifies
 * THIS object, never the cause, so a flag left behind here would be a flag that
 * silently stopped working. The only thing it adds is `attempts`, which is what
 * lets the row say "tried 3 times" instead of leaving someone to wonder whether
 * we gave up immediately.
 */
export class UploadFailure extends Error {
  readonly status: number | null;
  readonly attempts: number;
  readonly fromApi: boolean;
  readonly bytesLanded: boolean;
  /** The outstanding registration, carried across so "Retry" can be one POST. */
  readonly pending: PendingRegistration | null;
  readonly cause: unknown;

  constructor(cause: unknown, attempts: number) {
    super(messageOf(cause));
    this.name = "UploadFailure";
    this.status = statusOfError(cause);
    this.attempts = attempts;
    this.fromApi = errorFlag(cause, "fromApi");
    this.bytesLanded = errorFlag(cause, "bytesLanded");
    this.pending = pendingRegistration(cause);
    this.cause = cause;
  }
}

/**
 * uploadMediaFile, with up to MAX_FILE_ATTEMPTS goes at a transient failure.
 *
 * Every attempt is a clean start: uploadMediaFile re-derives the previews,
 * presigns a NEW key and uploads against that, so nothing is inherited from the
 * attempt that failed. The original costs nothing permanent — a failed multipart
 * is aborted inside multipartUpload, which is what refunds its reserved bytes,
 * and an unspent presign is refunded by the sweep.
 *
 * The two DERIVATIVES of an abandoned attempt are not so clean, and that is a
 * known cost rather than an oversight: they go up before the original and
 * normally land, so the sweep settles them "landed", which is never refunded,
 * while no Upload row ever points at them. Two tries at a file therefore leave
 * one orphaned thumb/preview pair (~300 KB) charged against the firm's 1 TB.
 * Bounded by MAX_FILE_ATTEMPTS and three orders of magnitude below the video
 * itself, so it buys the retry rather than paying for it; reclaiming them needs
 * a sweep that can tell an orphaned .derived/ object from a live one, which
 * nothing here can do (and CLAUDE.md forbids touching .derived/ anyway).
 *
 * A failure at REGISTRATION is excluded: it arrives as a RegistrationFailure,
 * which isRetryableUploadError refuses, because by then the bytes are stored and
 * the only thing missing is the row.
 *
 * `onAttempt` fires before each try, so the row can reset its progress bar
 * rather than appearing to jump backwards.
 */
export const uploadMediaFileWithRetry = async (
  opts: MediaUploadOpts & { onAttempt?: (attempt: number) => void }
): Promise<MediaUploadResult> => {
  const { onAttempt, ...rest } = opts;

  for (let attempt = 1; ; attempt += 1) {
    onAttempt?.(attempt);
    try {
      return await uploadMediaFile(rest);
    } catch (error) {
      // A cancel is not a failure and must not be dressed up as one.
      if (isCancellation(error)) throw error;
      if (attempt >= MAX_FILE_ATTEMPTS || !isRetryableUploadError(error)) {
        throw new UploadFailure(error, attempt);
      }
      await waitUnlessCancelled(
        withJitter(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1]),
        rest.signal
      );
    }
  }
};

/* ─────────────────────────────────────────────────────────────────────────
   Giving up on the whole batch
   ─────────────────────────────────────────────────────────────────────────
 *
 * A ceiling is not the only refusal that will answer every remaining file the
 * same way. When the connection itself is gone, every file fails with status 0
 * — but each one now burns MAX_FILE_ATTEMPTS presigns and ~10 s of backoff
 * first, so a 400-file folder dropped as the wifi dies spends about an hour
 * failing instead of the seconds it used to take. Both pages offer Stop, and
 * that is the uploader's lever; this is the page's own, for the case where
 * nobody is watching the screen.
 *
 * Five in a row, not one: a single file that cannot be reached is a bad file or
 * bad luck, and stopping a shoot because the third video timed out would be its
 * own failure. Five consecutive files answering "the request never arrived" is
 * the network, and the counter resets on anything else — including a success —
 * so a batch that is merely flaky still finishes.
 */
export const MAX_CONSECUTIVE_OFFLINE = 5;

/**
 * "The request never arrived" — see `post` and `api`, which both label it 0.
 *
 * Status 0 counts whether or not the bytes landed, because both shapes say the
 * same thing about Velocity: the request did not reach it. A genuine send
 * failure never got the file there; a landed-registration failure got the file
 * to storage but could not reach Velocity to record it. Five of either in a row
 * is Velocity being unreachable and the batch should stop — the only difference
 * is what the uploader is told, which handleUpload picks by whether the run of
 * offline failures was all landed ones (OFFLINE_LANDED_MESSAGE) or not
 * (OFFLINE_MESSAGE). A landed failure must therefore NOT reset the counter.
 *
 * (An earlier version excluded landed failures outright, to keep "5 files in a
 * row failed to send" off files that did send. That lost the signal rather than
 * relabelling it: a terabyte of storage reachable while Velocity is down would
 * upload bytes forever, register none, and never stop.)
 */
export const isOfflineError = (error: unknown): boolean => statusOfError(error) === 0;

/** What the batch says when it gives up because Velocity could not be reached. */
export const OFFLINE_MESSAGE = `Velocity can't be reached — ${MAX_CONSECUTIVE_OFFLINE} files in a row failed to send.`;

/**
 * What it says instead when every failure in that run was a landed one: the
 * bytes reached storage and only Velocity's record of them did not, so "failed
 * to send" would be wrong and alarming. The retry is register-only, which is how
 * it can promise nothing is uploaded twice.
 */
export const OFFLINE_LANDED_MESSAGE =
  "Files are reaching storage but Velocity can't record them right now. Stopped — press Retry in a few minutes; nothing will be uploaded twice.";

/**
 * Can a landed row still be recorded by another registration POST, or are its
 * bytes no good?
 *
 * A landed failure normally means only the record is missing, so Retry re-runs
 * the one POST. The ONLY answer that means the bytes are unusable is 422 from
 * /api/uploads: storage said the object is not there (a HEAD 404). That drops
 * the landed state so the next Retry sends the file again.
 *
 * Every other refusal keeps the register-only retry. Re-uploading cannot fix a
 * 400/403 (a fresh copy gets the same answer) and would only charge the firm for
 * a second copy; a failure to ASK storage comes back as 503 and is transient.
 */
export const LANDED_OBJECT_MISSING = 422;
export const landedBytesUsable = (error: unknown): boolean =>
  statusOfError(error) !== LANDED_OBJECT_MISSING;

/**
 * What to show on a file that failed, in words that mean something to whoever
 * is standing in front of the screen.
 *
 * "Cancelled" on four hundred rows after a dropped connection is what let two
 * days pass with nobody at Velocity knowing ~290 videos had not arrived. The
 * opaque classes — no answer, a timeout, a 5xx — get plain English and the
 * number of goes we had. Everything a 4xx says is the SERVER's own sentence,
 * because it is specific and actionable in a way no paraphrase here would be:
 * "Upload limit reached", "You don't have access to this event", "That file did
 * not finish uploading".
 */
export const failureReason = (error: unknown): string => {
  if (isCancellation(error)) return "Stopped";

  const attempts = error instanceof UploadFailure ? error.attempts : 1;
  const tried = attempts > 1 ? ` — tried ${attempts} times` : "";
  const message = messageOf(error);
  if (message.startsWith(QUOTA_MESSAGE)) return message;

  /* The one failure whose row must not read like a lost file: the video IS in
     storage, it is the Upload row that is missing, so "network dropped" would
     send someone to re-upload 40 GB we are already holding. The second half says
     what pressing Retry will actually do, because the row still sits under a
     button labelled "Retry failed files" and the fear it answers — "will that
     send my 40 GB again?" — is the reason people close the tab instead. */
  /* Only for the transient classes. A landed row refused with a definite 4xx
     shows the server's own sentence; a 422 (object genuinely missing) says
     Retry will send it again, because the page has dropped its landed state. */
  if (errorFlag(error, "bytesLanded")) {
    const landedStatus = statusOfError(error);
    if (landedStatus === LANDED_OBJECT_MISSING)
      return "That file did not finish uploading — Retry will send it again";
    if (landedStatus === null || landedStatus === 0 || landedStatus === 408 || landedStatus >= 500 || isQuotaError(error))
      return "Uploaded, saving didn't finish — Retry will only save it";
  }

  const status = statusOfError(error);
  if (status === null) return message;
  if (status === 0) return `Network dropped${tried}`;
  if (status === 408) return `Took too long${tried}`;
  if (status >= 500) return `Couldn't save on our side${tried}`;
  return message;
};

/* ─────────────────────────────────────────────────────────────────────────
   Files that are already uploaded
   ─────────────────────────────────────────────────────────────────────────

   A firm whose batch died halfway re-drops the SAME folder, because that is the
   only move the page offers them. Four hundred files then upload a second time:
   the quota pays for both copies, the gallery shows every photo twice, and the
   files that failed are no easier to find than before.

   So before a batch starts, the page asks what it has already sent for this
   event and drops the matches. The comparison has to be made on the values the
   KEY is built from, or it would be answering a different question than the one
   that matters: the folder the file would land in, sanitised segment by segment
   by the same functions the server uses, the file name after the same
   sanitising, and the size. */

/** One file the caller has already uploaded, as the server reports it. */
export type ExistingEntry = {
  /** Folder relative to the caller's own upload root; "" is the root itself. */
  path: string;
  /** Display name — the key's name segment, with its timestamp prefix stripped. */
  name: string;
  /** Null for rows written before sizeBytes existed; those match on name alone. */
  size: number | null;
};

export type ExistingIndex = {
  /** "<folder>\n<name>\n<size>" */
  sized: Set<string>;
  /** "<folder>\n<name>" for the rows whose size was never recorded. */
  unsized: Set<string>;
};

const EMPTY_INDEX: ExistingIndex = { sized: new Set(), unsized: new Set() };

const folderNameKey = (folder: string, name: string) => `${folder}\n${name}`;

/* Two Sets of strings rather than the rows themselves: ~10,000 entries is the
   realistic size of a delivered shoot and the rows are never needed again, only
   asked about. */
export const buildExistingIndex = (entries: ExistingEntry[]): ExistingIndex => {
  const index: ExistingIndex = { sized: new Set(), unsized: new Set() };
  for (const entry of entries) {
    if (typeof entry?.path !== "string" || typeof entry?.name !== "string") continue;
    const key = folderNameKey(entry.path, entry.name);
    if (typeof entry.size === "number") index.sized.add(`${key}\n${entry.size}`);
    else index.unsized.add(key);
  }
  return index;
};

/** Asks the server what this caller has already uploaded for one event. Throws;
 *  the caller decides what to say, and never blocks the upload on it. */
export const fetchExistingUploads = async (
  url: string,
  headers?: Record<string, string>
): Promise<ExistingIndex> => {
  const res = await fetch(url, headers ? { headers } : undefined);
  if (!res.ok) {
    const said = await res.json().catch(() => null);
    throw new UploadRequestError(said?.error || "Could not check what you have already uploaded", res.status);
  }
  const body = await res.json().catch(() => null);
  return buildExistingIndex(Array.isArray(body?.entries) ? (body.entries as ExistingEntry[]) : []);
};

/**
 * The folder a queued file would actually land in, relative to the caller's own
 * upload root: the folder they picked, with the directory the file was dropped
 * inside nested under it.
 *
 * Sanitised with splitFolderSegments — the function buildUploadKey itself uses —
 * so the string compared here cannot drift from the string the key is built
 * from. A separate "tidy up the path" helper is exactly how a skip check starts
 * silently missing every file in a folder with a comma in its name.
 */
export const plannedFolder = (target: string, droppedPath: string) =>
  splitFolderSegments([target, droppedPath].filter(Boolean).join("/")).join("/");

export type QueuedFile = { id: string; folder: string; name: string; size: number };

/** Why a queued file is not going to be uploaded. */
export type SkipReason = "already" | "duplicate";

/**
 * Which of these queued files should not be uploaded: the ones already sitting
 * in storage, and the ones that are an exact duplicate of an earlier file in
 * the same batch (dropping a folder and then dropping it again before pressing
 * Upload is a thing people do when they are not sure the first drop registered).
 *
 * The first of a set of duplicates is kept, so a batch of nothing but
 * duplicates still uploads one copy of each file.
 *
 * The two reasons are reported separately because only one of them is a
 * decision the uploader might disagree with. "Upload it again anyway" is a
 * sensible thing to want for a file we already hold; it is never a sensible
 * thing to want for the same file listed twice in one batch.
 *
 * `index` null means the lookup failed, or that the caller has asked to upload
 * everything again. Nothing is then reported as already uploaded — a failed
 * lookup must never be read as "you already have this" — while within-batch
 * duplicates are still dropped, which needs no server.
 */
export const skipDecisions = (
  queued: QueuedFile[],
  index: ExistingIndex | null
): Map<string, SkipReason> => {
  const skip = new Map<string, SkipReason>();
  const seen = new Set<string>();
  const known = index ?? EMPTY_INDEX;

  for (const file of queued) {
    const key = folderNameKey(file.folder, sanitizeSegment(file.name));
    const sized = `${key}\n${file.size}`;
    if (seen.has(sized)) {
      skip.set(file.id, "duplicate");
      continue;
    }
    seen.add(sized);
    /* Size has to agree when both sides know it — a re-export of the same shot
       under the same name is a different file and must still go up. A row with
       no size on record predates the column and can only be matched on name. */
    if (known.unsized.has(key) || known.sized.has(sized)) skip.set(file.id, "already");
  }

  return skip;
};

export type NotifyOpts = {
  eventId: string;
  phase: "start" | "end";
  fileCount: number;
  totalBytes: number;
  failed?: number;
  headers?: Record<string, string>;
};

/**
 * Tells the Velocity team a batch started or finished.
 *
 * Batched per upload run, not per file — a thousand-file shoot must not be a
 * thousand emails — and fire-and-forget: the upload must never wait on, or fail
 * because of, a mail server.
 *
 * Contributors get the "finished" email only, and that is the design rather
 * than an omission. The mail that goes out for a link holder is rate-limited on
 * the server by requiring an Upload row NEWER than the last one sent (see
 * claimContributorEmail in /api/uploads/notify) — without that, anyone holding a
 * forwarded link could drive mail to the firm's address in a loop from
 * Velocity's own SMTP. A "started" call is by definition made before the batch's
 * first file exists, so it can never satisfy that rule: every contributor start
 * notification was a request that travelled to the server to be refused.
 * Skipping it here says so out loud, and saves the round trip.
 *
 * `headers` carries the link credentials and is present for exactly the callers
 * that have no session — which is exactly the contributors.
 */
export const notifyUploadBatch = async ({
  eventId,
  phase,
  fileCount,
  totalBytes,
  failed = 0,
  headers
}: NotifyOpts): Promise<void> => {
  if (phase === "start" && headers) return;
  await fetch("/api/uploads/notify", {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify({ eventId, phase, fileCount, totalBytes, failed })
  }).catch(() => {});
};
