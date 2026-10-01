import crypto from "crypto";
import type { Status } from "@prisma/client";
import { prisma } from "./db";
import { getUploader } from "./rbac-server";
import type { Role } from "./rbac";
import { hasEventAccess, ensureProfile } from "./photographers";
import { KEY_PREFIX_BYTES, sanitizeSegment, splitFolderSegments } from "./uploadKey";

/* Open upload links — a firm's photographers uploading without an account.
 *
 * Server-only: every function here talks to the database or holds a secret.
 *
 * The situation this exists for: a photographer FIRM has one shared login, and
 * thirty people shooting in six states. Issuing each of them an ERP account is
 * not going to happen, so the firm mints a link instead — a URL, no password,
 * like a Drive upload folder.
 *
 * The whole design follows from one rule: a link is not a new principal. Every
 * byte that arrives through one is the FIRM's byte. The firm's event grant
 * authorises it, the firm's 1 TB pays for it, and it lands inside the firm's
 * one folder. A hundred links therefore cannot buy a hundred terabytes, which
 * is the only way the ceiling means anything.
 *
 * What a link DOES add is a name on the file and a folder of one's own, so the
 * firm and staff can see who sent what. That is the UploadContributor: created
 * the first time someone opens the link and types their name, remembered by a
 * secret their browser keeps.
 *
 * Confinement is by key prefix, not by trust. An actor carries an `uploadRoot`,
 * and every key the server mints for them is built underneath it; a reservation
 * or a registration naming a key outside it is refused. A contributor therefore
 * cannot write into another contributor's folder, into the firm's root, or into
 * the rest of the event, however the client is rewritten. */

export const LINK_HEADER = "x-upload-link";
export const CONTRIBUTOR_HEADER = "x-upload-contributor";

/** The firm folder, plus a contributor folder, plus room to nest. */
export const MAX_FOLDER_DEPTH = 8;

/** Expiry choices offered when a link is created, in days. */
export const LINK_DAY_CHOICES = [7, 30, 90] as const;
export const DEFAULT_LINK_DAYS = 30;

/** Past this a link is a liability rather than a convenience. */
export const MAX_CONTRIBUTORS_PER_LINK = 1000;

/** Display names are for a folder name and a label, not an essay. */
export const MAX_CONTRIBUTOR_NAME = 60;

// ---------------------------------------------------------------------------
// Tokens and secrets
// ---------------------------------------------------------------------------

/** 24 bytes — 192 bits of entropy, which is past guessing by any margin. */
export const generateToken = () => crypto.randomBytes(24).toString("base64url");

/* The per-device secret behind a contributor. The link token is a bearer value
   anyone can forward, so it says nothing about WHO is holding it; this does. */
export const generateSecret = () => crypto.randomBytes(32).toString("base64url");

export const hashSecret = (secret: string) => crypto.createHash("sha256").update(secret).digest("hex");

/* Constant-time over two hex digests. Length is compared first because
   timingSafeEqual throws on a mismatch rather than returning false. */
const sameHash = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

// ---------------------------------------------------------------------------
// Folder names
// ---------------------------------------------------------------------------

/* sanitizeSegment is NOT idempotent: it strips leading dots before trimming and
   cuts to 120 after, so " .Acme" becomes ".Acme" and a second pass makes that
   "_Acme". Folder names here are STORED and then compared against paths derived
   from keys — which are sanitised again by splitFolderSegments — so a name that
   changes under a second pass is a name whose own files fall outside it. Every
   stored segment therefore goes through two passes, which is a fixed point:
   after one pass there is no illegal character, no leading dot and no
   surrounding space left for a third pass to find. The migration's backfill
   applies its SQL equivalent twice for the same reason. */
export const stableSegment = (value: string) => sanitizeSegment(sanitizeSegment(value));

/* IST, fixed offset. India has no daylight saving and never has, so an offset
   is exact here in a way it would not be anywhere else — and it keeps this a
   pure function with no Intl locale data behind it. The folder name is written
   to the database once and has to stay stable forever, so it must not depend on
   the server's timezone. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, "0");

/* "." rather than ":" between hours and minutes: a colon is stripped by
   sanitizeSegment and is illegal in a Windows path, and these names end up both
   in an S3 key and in a downloaded ZIP's directory entries. */
export const contributorFolderName = (name: string, now: Date = new Date()) => {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const stamp = `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} ${pad(
    ist.getUTCHours()
  )}.${pad(ist.getUTCMinutes())}`;
  return stableSegment(`${name.trim().slice(0, MAX_CONTRIBUTOR_NAME)} ${stamp}`);
};

/* Candidate folder names for a firm, in the order they are tried. The uid comes
   first because it is meaningful and permanently unique; the numbers are a
   backstop for the case where even that collides. */
function* firmFolderCandidates(base: string, uid: string) {
  yield base;
  yield stableSegment(`${base.slice(0, 100)} (${uid})`);
  for (let n = 2; n <= 50; n += 1) yield stableSegment(`${base.slice(0, 110)} ${n}`);
}

const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === "P2002";

/* P2022: "the column does not exist in the current database". Migrations here
   are hand-written and applied after the code that needs them, so there is a
   window in which folderName is not there yet. */
const isMissingColumn = (error: unknown) => (error as { code?: string }).code === "P2022";

/**
 * The firm's folder inside every event: one folder per firm, holding everything
 * its main login and all of its links ever upload.
 *
 * Stored on the profile rather than derived on each call, because a firm that
 * renames itself must not have its existing files fall outside its own root.
 * Derived and persisted here the first time it is asked for; the migration
 * backfilled every profile that already existed.
 *
 * Null only when there is no such user — callers treat that as "no actor".
 *
 * Survives the deploy window before the migration lands. This sits in front of
 * presign, multipart create, registration and notify, so a P2022 here would
 * stop a firm uploading at all until the migration was applied; the derived
 * name is what the backfill would have written anyway, so files land in the
 * right folder and the column simply catches up.
 */
export const firmFolderName = async (userId: string): Promise<string | null> => {
  try {
    return await settleFirmFolderName(userId);
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    return user ? stableSegment(user.name) : null;
  }
};

const settleFirmFolderName = async (userId: string): Promise<string | null> => {
  const existing = await prisma.photographerProfile.findUnique({
    where: { userId },
    select: { folderName: true }
  });
  if (existing?.folderName) return existing.folderName;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, uid: true } });
  if (!user) return null;

  await ensureProfile(userId);

  const base = stableSegment(user.name);
  for (const candidate of firmFolderCandidates(base, user.uid)) {
    try {
      /* Guarded on folderName still being null, so a concurrent request that
         already settled on a name wins and this one adopts it rather than
         renaming the firm's root out from under files that are mid-upload. */
      const written = await prisma.photographerProfile.updateMany({
        where: { userId, folderName: null },
        data: { folderName: candidate }
      });
      if (written.count === 1) return candidate;

      const settled = await prisma.photographerProfile.findUnique({
        where: { userId },
        select: { folderName: true }
      });
      return settled?.folderName ?? null;
    } catch (error) {
      // Another firm holds this name. Try the next candidate.
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return null;
};

/**
 * Take a folder for a new contributor, inside `firmFolder` for this event.
 *
 * Collisions are rare — the name carries a minute-resolution timestamp — but two
 * people called Ravi starting together in the same minute is exactly the kind of
 * thing that happens on a shoot, and two contributors sharing a folder would make
 * "who uploaded this" unanswerable: their upload roots would be the same string,
 * which is the one thing keyWithinRoot exists to keep apart.
 *
 * So the name is CLAIMED, not checked. Reading MediaFolder and then returning
 * the candidate left a window in which two requests both saw it free; inserting
 * the row is what makes the (eventId, path) unique index decide, and exactly one
 * of the two can win it. The row is created before the contributor exists and is
 * stamped with the contributor id afterwards.
 *
 * Paths go through pathUnderRoot so every MediaFolder row — these and the ones
 * createFolder writes — is stored in the one normalised form.
 */
export const claimContributorFolder = async (
  eventId: string,
  firmFolder: string,
  base: string
): Promise<{ folderName: string; folderId: string | null }> => {
  const claim = async (candidate: string) => {
    try {
      const row = await prisma.mediaFolder.create({
        data: { eventId, path: pathUnderRoot(firmFolder, candidate) },
        select: { id: true }
      });
      return { folderName: candidate, folderId: row.id };
    } catch (error) {
      // Somebody already holds this folder. Not ours; try the next name.
      if (!isUniqueViolation(error)) throw error;
      return null;
    }
  };

  for (let n = 1; n <= 50; n += 1) {
    const candidate = n === 1 ? base : stableSegment(`${base.slice(0, 110)} ${n}`);
    const won = await claim(candidate);
    if (won) return won;
  }

  // 50 people, same name, same minute, same event. Fall back to something unique.
  const unique = stableSegment(`${base.slice(0, 100)} ${crypto.randomBytes(3).toString("hex")}`);
  return (await claim(unique)) ?? { folderName: unique, folderId: null };
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Sanitised segments of a path, joined — the exact form buildUploadKey uses. */
export const normalizeFolderPath = (path: string) => splitFolderSegments(path).join("/");

/**
 * A caller's folder, expressed relative to its own root, turned into the full
 * path relative to the event. `root` null means an employee, who addresses the
 * event directly.
 */
export const pathUnderRoot = (root: string | null, relative: string) => {
  const segments = [...(root ? splitFolderSegments(root) : []), ...splitFolderSegments(relative)];
  return segments.join("/");
};

/**
 * The inverse: a full event-relative path expressed relative to `root`, or null
 * if it is not inside it. "" means the root itself.
 */
export const pathRelativeToRoot = (fullPath: string, root: string | null): string | null => {
  const normalized = normalizeFolderPath(fullPath);
  if (!root) return normalized;
  const prefix = normalizeFolderPath(root);
  if (!prefix) return null;
  if (normalized === prefix) return "";
  return normalized.startsWith(`${prefix}/`) ? normalized.slice(prefix.length + 1) : null;
};

/**
 * Is this object key inside `root` for this event?
 *
 * The reservation and the registration both arrive from the browser carrying a
 * key, and both are legitimate — presign minted them. What has to be checked is
 * that the key belongs to the caller holding it: every contributor of a firm
 * shares the firm's user id, so the reservation's own owner check cannot tell
 * them apart. This can, because their roots differ.
 *
 * `root` null is an employee: the event is their root and there is nothing to
 * confine.
 */
/* S3 and R2 both refuse an object key longer than 1024 bytes. The quota is
   charged before the key is ever used, so a key that storage will reject has to
   be caught here rather than at the PUT, where nothing refunds it. */
export const MAX_KEY_BYTES = 1024;

/**
 * Is this folder path something a key may actually be built on: inside the
 * nesting limit the folder endpoints enforce, and short enough that the key
 * will not be refused by storage?
 *
 * `fileName` is the name the caller will hang off the path; the key also
 * carries the event id and the timestamp-and-nonce prefix `buildUploadKey`
 * adds (KEY_PREFIX_BYTES).
 *
 * The depth limit applies to callers who have a root — a firm or one of its
 * contributors, for whom MAX_FOLDER_DEPTH is already the rule the folder
 * endpoints enforce. An employee dragging in a deep directory tree is not who
 * that limit is for, and has never been held to it. The key length is physics
 * and applies to everyone.
 */
export const folderPathRejection = (
  folder: string,
  eventId: string,
  fileName: string,
  opts: { limitDepth?: boolean } = {}
): string | null => {
  if (opts.limitDepth && splitFolderSegments(folder).length > MAX_FOLDER_DEPTH) {
    return "Folders can't be nested that deep";
  }
  const keyLength =
    Buffer.byteLength(`uploads/${eventId}/${normalizeFolderPath(folder)}/${fileName}`) + KEY_PREFIX_BYTES;
  return keyLength > MAX_KEY_BYTES ? "That folder path is too long" : null;
};

export const keyWithinRoot = (key: string, eventId: string, root: string | null): boolean => {
  const eventPrefix = `uploads/${sanitizeSegment(eventId)}/`;
  if (!key.startsWith(eventPrefix)) return false;
  if (root === null) return true;
  const prefix = normalizeFolderPath(root);
  // An empty root would degrade to "anywhere in the event" — refuse instead.
  if (!prefix) return false;
  return key.startsWith(`${eventPrefix}${prefix}/`);
};

// ---------------------------------------------------------------------------
// Link status
// ---------------------------------------------------------------------------

/** "paused" is not stored: it means the firm or its grant has gone away. */
export type LinkStatus = "open" | "expired" | "revoked" | "paused";

export const linkStatus = (link: { revokedAt: Date | null; expiresAt: Date }, now: Date = new Date()): LinkStatus => {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt.getTime() <= now.getTime()) return "expired";
  return "open";
};

// ---------------------------------------------------------------------------
// Resolving a link for the public pages
// ---------------------------------------------------------------------------

export type ResolvedLink = {
  link: {
    id: string;
    token: string;
    label: string | null;
    eventId: string;
    photographerId: string;
    expiresAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
    lastUsedAt: Date | null;
  };
  firm: { id: string; name: string; status: Status; folder: string };
  event: { id: string; eventName: string; companyName: string; fromDate: Date; toDate: Date };
  status: LinkStatus;
};

/**
 * Everything the public endpoints need about a token, including WHY it is shut.
 *
 * Null means no such link at all. Anything else comes back with a status, so a
 * closed link can be told apart from a mistyped URL — "this link expired on the
 * 4th" is a usable answer and "not found" is not.
 *
 * A link stops working the moment the firm is deactivated or its grant on the
 * event is revoked, without anyone having to remember to close the link. That is
 * the "paused" status: the link itself is still fine, its authority is not.
 */
export const resolveOpenLink = async (token: string): Promise<ResolvedLink | null> => {
  if (!token) return null;

  const row = await prisma.uploadLink.findUnique({
    where: { token },
    include: {
      photographer: { select: { id: true, name: true, status: true, role: true } },
      event: { select: { id: true, eventName: true, companyName: true, fromDate: true, toDate: true } }
    }
  });
  if (!row) return null;

  const folder = await firmFolderName(row.photographerId);
  if (folder === null) return null;

  let status = linkStatus(row);
  if (status === "open") {
    const live =
      row.photographer.status === "ACTIVE" &&
      row.photographer.role === "PHOTOGRAPHER" &&
      (await hasEventAccess(row.photographerId, row.eventId));
    if (!live) status = "paused";
  }

  return {
    link: {
      id: row.id,
      token: row.token,
      label: row.label,
      eventId: row.eventId,
      photographerId: row.photographerId,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt
    },
    firm: { id: row.photographer.id, name: row.photographer.name, status: row.photographer.status, folder },
    event: row.event,
    status
  };
};

// ---------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------

export type UploadActor = {
  /** The FIRM's user id for a photographer or a contributor; the employee's otherwise. */
  id: string;
  name: string;
  role: Role;
  status: Status;
  isPhotographer: boolean;
  contributor: null | { id: string; name: string; linkId: string; eventId: string; folderPath: string };
  /** null = employee, unrestricted. Otherwise every key must be built under it. */
  uploadRoot: string | null;
  /** What this actor may SEE: the firm's whole folder, for firm and contributor alike. */
  viewRoot: string | null;
};

/* lastUsedAt / lastSeenAt are tracking, not authorisation. Writing them on every
   presign would put two extra round trips in front of each file of a thousand-file
   shoot, so they are refreshed at most once a minute and never awaited: a dropped
   update costs a slightly stale "last activity" and nothing else. */
const TOUCH_INTERVAL_MS = 60 * 1000;

const stale = (at: Date | null, now: number) => at === null || now - at.getTime() > TOUCH_INTERVAL_MS;

const touch = (link: { id: string; lastUsedAt: Date | null }, contributor: { id: string; lastSeenAt: Date | null }) => {
  const now = Date.now();
  const when = new Date(now);
  if (stale(link.lastUsedAt, now)) {
    void prisma.uploadLink.update({ where: { id: link.id }, data: { lastUsedAt: when } }).catch(() => {});
  }
  if (stale(contributor.lastSeenAt, now)) {
    void prisma.uploadContributor
      .update({ where: { id: contributor.id }, data: { lastSeenAt: when } })
      .catch(() => {});
  }
};

/** "<contributorId>.<secret>" — a uuid holds no dots, so the first one splits it. */
const splitCredential = (value: string): [string, string] | null => {
  const at = value.indexOf(".");
  if (at <= 0 || at === value.length - 1) return null;
  return [value.slice(0, at), value.slice(at + 1)];
};

const contributorActor = async (
  token: string,
  credential: string,
  expectEventId?: string,
  known?: ResolvedLink
): Promise<UploadActor | null> => {
  const parts = splitCredential(credential);
  if (!parts) return null;
  const [contributorId, secret] = parts;

  /* The caller may already have resolved this token (the public endpoints all
     do, to decide whether the link is open before anything else). Reused only
     when it is the SAME token — the header is what authorises this request, so
     a mismatch has to go back to the database rather than be papered over. */
  const resolved = known && known.link.token === token ? known : await resolveOpenLink(token);
  if (!resolved || resolved.status !== "open") return null;

  /* Pinned before anything is signed: a contributor's link is for ONE event, and
     a body naming a different one must not be served by the authority of this
     link even if the firm happens to hold that other event too. */
  if (expectEventId && expectEventId !== resolved.link.eventId) return null;

  const contributor = await prisma.uploadContributor.findUnique({ where: { id: contributorId } });
  if (!contributor || contributor.linkId !== resolved.link.id) return null;
  if (!sameHash(contributor.secretHash, hashSecret(secret))) return null;

  touch({ id: resolved.link.id, lastUsedAt: resolved.link.lastUsedAt }, contributor);

  const folderPath = `${resolved.firm.folder}/${contributor.folderName}`;
  return {
    id: resolved.firm.id,
    name: resolved.firm.name,
    role: "Photographer",
    status: resolved.firm.status,
    isPhotographer: true,
    contributor: {
      id: contributor.id,
      name: contributor.name,
      linkId: resolved.link.id,
      eventId: resolved.link.eventId,
      folderPath
    },
    /* Uploads are confined to their own folder; viewing is the whole firm
       folder, so a contributor can see what the rest of the firm delivered. */
    uploadRoot: folderPath,
    viewRoot: resolved.firm.folder
  };
};

/**
 * Who is making this upload request: an employee, a firm's main login, or a
 * person holding one of that firm's open links.
 *
 * The link headers are an ALTERNATIVE to a session, never an addition to one.
 * If they are present this returns the contributor actor or nothing at all — it
 * never falls back to the cookie, and a session user is never re-read through
 * them. Otherwise a contributor credential sent alongside an employee's cookie
 * would be a way to borrow one principal's authority under another's name.
 */
export async function getUploadActor(
  request: Request,
  opts?: { eventId?: string; link?: ResolvedLink }
): Promise<UploadActor | null> {
  const token = request.headers.get(LINK_HEADER);
  const credential = request.headers.get(CONTRIBUTOR_HEADER);

  if (token || credential) {
    if (!token || !credential) return null;
    return contributorActor(token, credential, opts?.eventId, opts?.link);
  }

  const uploader = await getUploader(request);
  if (!uploader) return null;

  if (!uploader.isPhotographer) {
    return { ...uploader, contributor: null, uploadRoot: null, viewRoot: null };
  }

  /* The firm's main login writes into the firm folder's root and may create
     folders anywhere inside it — the same root it can see. */
  const folder = await firmFolderName(uploader.id);
  if (folder === null) return null;
  return { ...uploader, contributor: null, uploadRoot: folder, viewRoot: folder };
}
