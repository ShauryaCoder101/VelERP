import crypto from "crypto";

/* One key per file, whichever way the bytes travel.
 *
 * /api/uploads/presign mints the object key and signs the thumbnail and preview
 * slots against it — derivativeKeyFor(key) is a pure function of that key, and
 * the gallery finds them again by applying the same function to the stored
 * fileUrl. That only works if the original actually lands on that key.
 *
 * It did not, for anything over MULTIPART_THRESHOLD. presign returned the
 * derivative slots for key K and told the client to go multipart; /api/uploads/
 * multipart then called buildUploadKey a second time, whose `Date.now()` prefix
 * produced a different key K2. The original went to K2, the thumbnails sat at
 * K's derived path, and derivativeUrlFor(K2) pointed at nothing. Every photo
 * and video over 16MB has been thumbnail-less since multipart was introduced.
 *
 * The reservation is how presign hands its key to the multipart route without
 * trusting the browser with it. The browser carries the token; the server only
 * accepts a key that came out of its own HMAC. Without that, `key` would be a
 * client-supplied string and any caller could write anywhere in the bucket.
 *
 * Server-only: it reads secrets from the environment. */

const baseSecret = () =>
  process.env.SHARE_LINK_SECRET ??
  /* Same derivation as lib/shareToken.ts, so this works with no new environment
     variable. Set SHARE_LINK_SECRET in production. */
  crypto
    .createHash("sha256")
    .update(`velocity-share|${process.env.S3_SECRET_ACCESS_KEY ?? ""}|${process.env.DATABASE_URL ?? ""}`)
    .digest("hex");

/* Every HMAC in the upload path hangs off the same base secret, so the label is
   what keeps them apart. Two values signed under different labels can never be
   replayed as one another even though the key material is identical — a share
   token cannot be presented as a reservation, nor a reservation as a multipart
   ticket, because neither verifies under the other's derived key. */
export const uploadHmacKey = (label: string) =>
  crypto.createHmac("sha256", baseSecret()).update(label).digest();

const RESERVATION_LABEL = "velocity-upload-reservation-v1";

/** Long enough for a slow overnight upload, short enough to be worth nothing later. */
export const RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

export type ReservationPurpose = "media" | "document";

type Reservation = {
  /** object key */
  k: string;
  /** event id */
  e: string;
  /** user id this reservation was issued to */
  i: string;
  /** storage purpose — pinned so a document key cannot be spent on the media bucket */
  p: ReservationPurpose;
  /** expiry, epoch ms */
  x: number;
};

export const signReservation = (input: {
  key: string;
  eventId: string;
  userId: string;
  purpose: ReservationPurpose;
}): string => {
  const payload: Reservation = {
    k: input.key,
    e: input.eventId,
    i: input.userId,
    p: input.purpose,
    x: Date.now() + RESERVATION_TTL_MS
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", uploadHmacKey(RESERVATION_LABEL)).update(body).digest("base64url");
  return `${body}.${sig}`;
};

/**
 * Returns the reserved key, or null if the token is forged, expired, or was
 * issued for a different user, event or storage purpose. Every mismatch is one
 * answer: a caller learns nothing from which check failed.
 */
export const verifyReservation = (
  token: unknown,
  expect: { userId: string; eventId: string; purpose: ReservationPurpose }
): string | null => {
  if (typeof token !== "string" || !token) return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(
    crypto.createHmac("sha256", uploadHmacKey(RESERVATION_LABEL)).update(body).digest("base64url")
  );
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as Reservation;
    if (typeof payload.k !== "string" || !payload.k) return null;
    if (typeof payload.x !== "number" || Date.now() > payload.x) return null;
    if (payload.i !== expect.userId) return null;
    if (payload.e !== expect.eventId) return null;
    if (payload.p !== expect.purpose) return null;
    return payload.k;
  } catch {
    return null;
  }
};
