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

import { statusOfError, uploadFile, UploadRequestError } from "./upload-client";
import { makeDerivatives } from "./derivatives";

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
 * Takes the error rather than its message so the status survives; a bare
 * string still works, for the quota case, so older call sites are not wrong.
 */
export const isQuotaError = (error: unknown): boolean => {
  if (statusOfError(error) === 429) return true;
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return message.startsWith(QUOTA_MESSAGE);
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
  const res = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    /* The status rides with the message: it is what tells a batch that this
       refusal is a ceiling every remaining file would hit too. */
    const said = await res.json().catch(() => null);
    throw new UploadRequestError(said?.error || fallback, res.status);
  }
  return res.json();
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

  const upload: RegisteredUpload = await post(
    "/api/uploads",
    { eventId, fileUrl, fileType: contentTypeOf(file) },
    headers,
    "Uploaded, but could not be recorded",
    signal
  );

  return { upload, fileUrl, derivativeFailures };
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
