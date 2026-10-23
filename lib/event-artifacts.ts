import { hasAccess, type Role } from "./rbac";
import { sanitizeSegment } from "./uploadKey";

/* Event artifacts: the working documents of an event, as opposed to its media.
 *
 * The one rule that shapes everything here is that artifacts must never be
 * reachable through anything that reads media. The gallery, the client share
 * links, the ZIP builder, the photographer views and /api/uploads all read the
 * Upload table, and registration there refuses any key that is not under
 * `uploads/<eventId>/` (app/api/uploads/route.ts). Putting artifacts in their
 * own table UNDER THEIR OWN PREFIX is therefore not a tidiness preference: it
 * is what makes "a pitch deck can never appear in a client's gallery" true by
 * construction rather than by every reader remembering a filter.
 *
 * Client-safe on purpose — no prisma, no storage, no node builtins — because the
 * category list and labels are also what the event page renders.
 */

/** Fixed set, fixed order: the UI renders one tab per entry, in this order. */
export const ARTIFACT_CATEGORIES = ["PPT", "EVENT_FLOW", "CREATIVES", "LAYOUTS", "CUSTOMER_DATA"] as const;

export type ArtifactCategoryKey = (typeof ARTIFACT_CATEGORIES)[number];

export const ARTIFACT_CATEGORY_LABELS: Record<ArtifactCategoryKey, string> = {
  PPT: "PPT",
  EVENT_FLOW: "Event Flow",
  CREATIVES: "Creatives",
  LAYOUTS: "Layouts",
  CUSTOMER_DATA: "Customer Data"
};

/** The list the API hands the UI, so the labels live in exactly one place. */
export const ARTIFACT_CATEGORY_LIST: { key: ArtifactCategoryKey; label: string }[] =
  ARTIFACT_CATEGORIES.map((key) => ({ key, label: ARTIFACT_CATEGORY_LABELS[key] }));

/** A category from a request body, or null. Never a cast: the value reaches a
 *  Prisma enum column and an unknown string would be a 500 at the write. */
export const parseArtifactCategory = (value: unknown): ArtifactCategoryKey | null =>
  typeof value === "string" && (ARTIFACT_CATEGORIES as readonly string[]).includes(value)
    ? (value as ArtifactCategoryKey)
    : null;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/* The root segment that separates artifacts from media inside the media bucket.
   Checked by /api/uploads/multipart before it will spend a reservation, so it
   has to be one constant rather than a string literal in two files. */
export const ARTIFACT_KEY_ROOT = "artifacts";

/** Everything this event's artifacts sit under, trailing slash included. */
export const artifactEventPrefix = (eventId: string) =>
  `${ARTIFACT_KEY_ROOT}/${sanitizeSegment(eventId)}/`;

/** ...and one category of them. The category is an enum value, so it is already
 *  nothing but A-Z and underscores; sanitising it would be a no-op. */
export const artifactCategoryPrefix = (eventId: string, category: ArtifactCategoryKey) =>
  `${artifactEventPrefix(eventId)}${category}/`;

/* The random half of a key's uniqueness, in the same shape lib/uploadKey.ts
 * uses: 48 bits of entropy joined to the millisecond with a DOT.
 *
 * Duplicated rather than imported because keyNonce is private there, and the
 * reasoning behind both halves of the format belongs with the original — see
 * KEY_NONCE_JOIN in lib/uploadKey.ts. What matters here is the consequence: two
 * employees dropping "Pitch.pptx" into Creatives in the same millisecond must
 * not produce the same key, because the second upload would silently overwrite
 * the first and the (eventId, fileUrl) unique index would fold both into one
 * row.
 *
 * Web Crypto, not node:crypto, so this module stays importable from a client
 * component.
 */
const keyNonce = () => {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * artifacts/<eventId>/<CATEGORY>/<epochMs>.<nonce>-<sanitised name>
 *
 * sanitizeSegment caps each segment at 120 characters, so this key cannot
 * approach storage's 1024-byte limit however long a file name is — which is why
 * there is no length rejection on this path, unlike the folder uploads one.
 */
export const buildArtifactKey = (
  eventId: string,
  category: ArtifactCategoryKey,
  fileName: string
) =>
  `${artifactCategoryPrefix(eventId, category)}${Date.now()}.${keyNonce()}-${sanitizeSegment(fileName)}`;

/* The name segment buildArtifactKey produces, and nothing else: the millisecond
   stamp, the 48-bit nonce, and a name that has been through sanitizeSegment (so
   only [A-Za-z0-9._ -], at most 120 characters). Must be kept in step with
   buildArtifactKey above — they are the two halves of one format. */
const ARTIFACT_NAME_SEGMENT = /^\d{10,16}\.[0-9a-f]{12}-[a-zA-Z0-9._ -]{1,120}$/;

/**
 * Is this storage key one we minted for this event and category?
 *
 * Registration is where a browser's claim about a key becomes a row, so the
 * claim is checked against the FORMAT rather than merely against the prefix. A
 * prefix test alone admits anything nested below it — extra segments, dot
 * segments, a query-looking tail — and every one of those is a string that might
 * or might not name the same object as somebody else's key depending on what
 * normalises it on the way to storage. Only keys of exactly this shape exist in
 * the bucket, so only keys of exactly this shape are worth accepting.
 */
export const isArtifactKey = (eventId: string, category: ArtifactCategoryKey, key: string) => {
  const prefix = artifactCategoryPrefix(eventId, category);
  return key.startsWith(prefix) && ARTIFACT_NAME_SEGMENT.test(key.slice(prefix.length));
};

// ---------------------------------------------------------------------------
// File types
// ---------------------------------------------------------------------------

export const GENERIC_FILE_TYPE = "application/octet-stream";

/* type/subtype and nothing else. Deliberately not a full RFC 2045 grammar: what
   matters is that the value cannot contain a space, a quote, a semicolon or a
   CR/LF, because it leaves this system again as a SIGNED ResponseContentType on
   a storage URL and comes back as a response header. */
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_+.-]{0,62}\/[a-z0-9][a-z0-9!#$&^_+.-]{0,62}$/;

/**
 * The fileType to STORE for a registration.
 *
 * fileType is whatever the registering browser said it was, so it is a claim,
 * and the row is what later decides a signed response's Content-Type. Normalised
 * here rather than trusted: lowercased, parameters dropped, bounded, and
 * anything that is not a plain MIME type becomes the generic type — which
 * downloads and is never offered for viewing.
 *
 * NOT applied to the presign call: the single PUT is signed against the exact
 * Content-Type the browser will send (`file.type`), and normalising one side of
 * that would break the signature rather than any attack.
 */
export const normalizeFileType = (value: unknown): string => {
  if (typeof value !== "string") return GENERIC_FILE_TYPE;
  /* Parameters are dropped rather than rejected — "text/csv;charset=utf-8" is a
     real File.type on some platforms and nothing here wants the charset. */
  const type = value.split(";")[0].trim().toLowerCase();
  return MIME_TYPE.test(type) ? type : GENERIC_FILE_TYPE;
};

/* The only types a view URL may be signed `inline` for.
 *
 * An allow-list, not a block-list, because an inline response is rendered as a
 * DOCUMENT on the storage origin — which holds every event's files — and both
 * text/html and image/svg+xml carry script. SVG is excluded for exactly that
 * reason although it is an image. Everything else is handed over as an
 * attachment, which no browser executes.
 *
 * Shared with the UI so the View button and the signature answer the same
 * question: the endpoint is reachable directly, so the UI's restriction is
 * cosmetic and this is the actual control. */
const INLINE_IMAGE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif"
];

/** Renders in an <img>, and safe to serve inline. */
export const isInlineImageType = (fileType: string) =>
  INLINE_IMAGE_TYPES.includes(normalizeFileType(fileType));

/** May be opened in a tab: a PDF or one of the inert raster formats. */
export const isInlineViewableType = (fileType: string) =>
  normalizeFileType(fileType) === "application/pdf" || isInlineImageType(fileType);

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

/* Role level 1 is the Managing Director and nothing else (lib/rbac.ts
   ROLE_LEVEL_GROUPS), and `role` here is always the display label
   normalizeRole produced — getSessionUser maps the RoleName enum through it
   before anything sees a session, so a raw "MANAGING_DIRECTOR" never reaches
   this. Asked by level, the way every other MD check in the codebase asks
   (app/api/events/[id]/sanctions), rather than comparing against a label string
   that a rename would silently break. hasAccess rather than rbac-server's
   requireMinLevel because that module reaches the database, and this one is
   imported by a client component. */
export const isManagingDirector = (role: Role) => hasAccess(role, 1);

/**
 * May this employee delete this artifact?
 *
 * Everyone uploads, everyone sees, but deletion is confined to your own files —
 * with the Managing Director able to delete anything. Returned to the UI as
 * `canDelete` and re-decided on the DELETE itself: the flag drives the button,
 * the check is what enforces it.
 */
export const canDeleteArtifact = (
  viewer: { id: string; role: Role },
  artifact: { uploadedById: string }
) => artifact.uploadedById === viewer.id || isManagingDirector(viewer.role);
