import crypto from "crypto";

/* Client links are stateless: the token *is* the grant. It carries the event,
   an optional folder, and a hard expiry, all covered by an HMAC. No table, no
   migration, and no database round trip to open a link.

   Trade-off worth knowing: a stateless grant cannot be revoked before it
   expires, and the ceiling is now 30 days. Rotating SHARE_LINK_SECRET is the
   emergency stop, but it invalidates every live link at once. If you need to
   kill one link, that is the point at which a MediaShare table earns its keep. */

export const MIN_TTL_DAYS = 2;
export const MAX_TTL_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_TTL_MS = MIN_TTL_DAYS * DAY_MS;
const MAX_TTL_MS = MAX_TTL_DAYS * DAY_MS;

const secret = () => {
  const explicit = process.env.SHARE_LINK_SECRET;
  if (explicit) return explicit;
  /* Fall back to a value derived from existing server-only config so the
     feature works with no new environment variable. Set SHARE_LINK_SECRET in
     production: rotating your S3 key would otherwise invalidate live links. */
  return crypto
    .createHash("sha256")
    .update(`velocity-share|${process.env.S3_SECRET_ACCESS_KEY ?? ""}|${process.env.DATABASE_URL ?? ""}`)
    .digest("hex");
};

export type SharePayload = {
  /** event id */
  e: string;
  /** folder scope, null for the whole event */
  f: string | null;
  /** expiry, epoch ms */
  x: number;
};

export const createShareToken = (eventId: string, folder: string | null, ttlMs: number) => {
  // Clamped here as well as at the API, so no caller can mint a longer grant.
  const expires = Date.now() + Math.min(Math.max(ttlMs, MIN_TTL_MS), MAX_TTL_MS);
  const payload: SharePayload = { e: eventId, f: folder || null, x: expires };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return { token: `${body}.${sig}`, expires };
};

export const verifyShareToken = (token: string): SharePayload | null => {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");

  const given = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SharePayload;
    if (typeof payload.e !== "string" || typeof payload.x !== "number") return null;
    if (Date.now() > payload.x) return null;
    return payload;
  } catch {
    return null;
  }
};
