import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { prisma } from "./db";
import { resolveForUrl } from "./storage";
import { isArchived } from "./archive";
import {
  folderFromFileUrl,
  displayNameFromFileUrl,
  derivativeUrlFor,
  splitFolderSegments
} from "./uploadKey";

/* Building a browsable list of an event's media: names, folders, and signed
 * thumbnail / preview / original / download URLs.
 *
 * Server-only — it talks to the database and holds storage credentials.
 *
 * This was the body of app/api/share/[token]/route.ts until a photographer
 * needed the same gallery over their own session instead of a client token.
 * Two copies of "which folder is this in, is it cold, what does the download
 * URL look like" would drift, and the drift would show up as a client and a
 * photographer disagreeing about what is in an event. There is one copy now;
 * the two callers differ only in how they prove they are allowed to ask.
 *
 * Authorisation is deliberately NOT here. A token check and a grant check look
 * nothing alike, and burying either one behind this function would make it easy
 * to call without one. Callers gate first, then build. */

export type MediaItem = {
  id: string;
  name: string;
  fileType: string;
  folder: string;
  archived: boolean;
  size: number | null;
  uploadedAt: string;
  thumb: string | null;
  preview: string | null;
  original: string | null;
  download: string | null;
  /** Only set when a viewerId was supplied: did this viewer upload the file. */
  mine?: boolean;
  /* Only set when withUploader: who sent it. A firm's people all upload as the
     firm, so without this a contributor browsing the firm folder sees thirty
     people's work with one name on all of it. */
  by?: string;
};

/** Staff uploads are attributed to the company, not to the individual employee. */
const STAFF_LABEL = "Velocity team";

/** A share grant may be scoped to one folder; `null` means the whole event. */
const inScope = (fileUrl: string, eventId: string, folder: string | null) => {
  if (!folder) return true;
  /* Both sides normalised, not compared raw. The scope can now be a STORED
     name — a firm's folder, read from PhotographerProfile — while the path on
     the left is derived from a key, which was sanitised on the way in. A stored
     name that is not a fixed point of that sanitising (" .Acme" stored, keys
     built under "_Acme") would match nothing at all, and the failure is silent:
     uploads keep working and the gallery is simply empty. */
  const root = splitFolderSegments(folder).join("/");
  if (!root) return false;
  const at = splitFolderSegments(folderFromFileUrl(fileUrl, eventId)).join("/");
  return at === root || at.startsWith(`${root}/`);
};

/* A cross-origin <a download> is ignored by browsers, so the disposition has
   to come from storage itself — signed into the URL. */
const sign = async (fileUrl: string | null, expiresIn: number, downloadAs?: string) => {
  if (!fileUrl) return null;
  const found = resolveForUrl(fileUrl);
  if (!found) return null;
  try {
    return await getSignedUrl(
      found.profile.client,
      new GetObjectCommand({
        Bucket: found.profile.bucket,
        Key: found.key,
        ...(downloadAs
          ? { ResponseContentDisposition: `attachment; filename="${downloadAs.replace(/"/g, "")}"` }
          : {})
      }),
      { expiresIn }
    );
  } catch {
    return null;
  }
};

export async function buildMediaItems(opts: {
  eventId: string;
  folder: string | null;
  expiresIn: number;
  /** When given, each item reports whether this user uploaded it. */
  viewerId?: string;
  /* The viewer is someone holding an open upload link rather than an account.
     Takes precedence over viewerId, which for them is the firm's id and would
     mark the whole firm's output as theirs. */
  viewerContributorId?: string;
  /** Label each item with who sent it. */
  withUploader?: boolean;
}): Promise<MediaItem[]> {
  const { eventId, folder, expiresIn, viewerId, viewerContributorId, withUploader } = opts;

  const uploads = await prisma.upload.findMany({
    where: { eventId },
    select: {
      id: true,
      fileUrl: true,
      fileType: true,
      sizeBytes: true,
      createdAt: true,
      uploadedBy: true,
      contributorId: true,
      /* Two extra relation queries for the whole list, not per row — Prisma
         resolves these as separate IN queries. Selected unconditionally to keep
         one query shape; `by` is only emitted when the caller asked for it. */
      contributor: { select: { name: true } },
      user: { select: { name: true, role: true } }
    },
    orderBy: { createdAt: "asc" }
  });

  const scoped = uploads.filter((u) => inScope(u.fileUrl, eventId, folder));

  return Promise.all(
    scoped.map(async (u) => {
      const name = displayNameFromFileUrl(u.fileUrl);
      const cold = isArchived(u.createdAt);

      /* Thumbnails and previews are never archived, so a viewer can always browse.
         Originals from a cold event are not offered for download here — restoring
         from Deep Archive takes 12-48h and has to be requested by staff. */
      const [thumb, preview, original, download] = await Promise.all([
        sign(derivativeUrlFor(u.fileUrl, "thumb"), expiresIn),
        sign(derivativeUrlFor(u.fileUrl, "preview"), expiresIn),
        cold ? Promise.resolve(null) : sign(u.fileUrl, expiresIn),
        cold ? Promise.resolve(null) : sign(u.fileUrl, expiresIn, name)
      ]);

      return {
        id: u.id,
        name,
        fileType: u.fileType,
        /* Number, not BigInt: Response.json throws on a BigInt. A photo or a
           video is nowhere near 2^53 bytes, so nothing is lost. Null for rows
           written before the column existed — the ZIP still works, it just
           cannot show a percentage. */
        size: u.sizeBytes === null ? null : Number(u.sizeBytes),
        folder: folderFromFileUrl(u.fileUrl, eventId),
        archived: cold,
        uploadedAt: u.createdAt.toISOString(),
        thumb,
        preview,
        original,
        download,
        /* Absent, not false, for a caller that did not identify a viewer.
           For a link user "mine" is their contributor row; for anyone else it is
           their account AND no contributor — otherwise the firm's main login
           would claim every file its link users ever sent, since they all
           upload as the firm. */
        ...(viewerContributorId
          ? { mine: u.contributorId === viewerContributorId }
          : viewerId
            ? { mine: u.uploadedBy === viewerId && !u.contributorId }
            : {}),
        ...(withUploader
          ? {
              by: u.contributor
                ? u.contributor.name
                : u.user.role === "PHOTOGRAPHER"
                  ? u.user.name
                  : STAFF_LABEL
            }
          : {})
      };
    })
  );
}

/* The browser builds a "download everything" ZIP itself (lib/zip-download.ts),
 * and a 300 GB archive takes longer to write than a presigned URL lives. Signing
 * the whole set up front would hand out thousands of URLs most of which expire
 * before their turn, so the client comes back for a batch at a time as the ZIP
 * advances — hence a cap rather than an unbounded list.
 *
 * No Content-Disposition: these URLs are read by fetch(), which does not care,
 * and a disposition would only confuse the entry name client-zip records. */
const MAX_IDS = 200;

export async function signMediaDownloads(opts: {
  eventId: string;
  folder: string | null;
  ids: string[];
  expiresIn: number;
}): Promise<Record<string, string>> {
  const { eventId, folder, expiresIn } = opts;

  const ids = [...new Set(opts.ids.filter((v): v is string => typeof v === "string" && v.length > 0))].slice(
    0,
    MAX_IDS
  );
  if (ids.length === 0) return {};

  // The eventId filter is the scope gate: an id from another event simply misses.
  const uploads = await prisma.upload.findMany({
    where: { id: { in: ids }, eventId },
    select: { id: true, fileUrl: true, createdAt: true }
  });

  const signed = await Promise.all(
    uploads.map(async (upload) => {
      if (!inScope(upload.fileUrl, eventId, folder)) return null;
      /* A cold original is in Deep Archive; a signed URL for it would come back
         InvalidObjectState mid-ZIP. Omit it and let the client list it as
         not included. */
      if (isArchived(upload.createdAt)) return null;

      const url = await sign(upload.fileUrl, expiresIn);
      return url ? ([upload.id, url] as const) : null;
    })
  );

  const urls: Record<string, string> = {};
  for (const entry of signed) if (entry) urls[entry[0]] = entry[1];
  return urls;
}
