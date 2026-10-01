import { prisma } from "../../../lib/db";
import { folderFromFileUrl, sanitizeSegment, splitFolderSegments } from "../../../lib/uploadKey";
import {
  MAX_FOLDER_DEPTH,
  normalizeFolderPath,
  pathRelativeToRoot,
  pathUnderRoot
} from "../../../lib/upload-links";

/* Listing and creating folders, shared by the three doors onto them: the firm's
 * main login (/api/media-folders), someone holding an open link
 * (/api/upload-links/public/[token]/folders), and staff.
 *
 * Underscore-prefixed so the App Router treats it as a private file rather than
 * a route segment.
 *
 * Folders are key prefixes, so a folder with files in it needs no row at all —
 * lib/uploadKey.ts puts the path in the key and folderFromFileUrl reads it back.
 * A MediaFolder row exists only so an EMPTY folder survives: press "New folder",
 * close the tab, come back, and it is still there. The two are unioned here, and
 * every ancestor is filled in, so a picker gets a complete tree whether a level
 * was created deliberately or fell out of a dragged-in directory.
 *
 * Confinement is the caller's root. `root` null is an employee, for whom the
 * event is the root; a photographer or a contributor always has one, and
 * pathUnderRoot builds the result underneath it from sanitised segments, so
 * neither "../" nor an absolute path in `parent` can reach outside. */

/** Enough for a deep shoot, few enough that a picker is still a picker. */
const MAX_FOLDERS_PER_CREATOR = 500;

/* And a ceiling for a whole link, because the per-creator one is per IDENTITY
   and identities are free: /contributors is open to anyone holding the link and
   admits a thousand of them, so 500 each would be half a million rows one
   forwarded URL could mint — rows nothing in this app can delete, loaded by
   every folder listing for that event thereafter. A real shoot does not need
   two thousand folders; an endpoint being hammered passes that in a minute. */
const MAX_FOLDERS_PER_LINK = 2000;

/**
 * Every folder under `root` for this event, as full event-relative paths.
 *
 * `root` null lists the whole event. Sorted, deduplicated, ancestors included.
 */
export const listFolders = async (eventId: string, root: string | null): Promise<string[]> => {
  const [rows, dirs] = await Promise.all([
    prisma.mediaFolder.findMany({ where: { eventId }, select: { path: true } }),
    /* Distinct DIRECTORIES, not every file.
       Folders are key prefixes, so the folder list is implied by the uploads —
       but reading one row per file to compute it means a 40,000-file wedding is
       40,000 strings in memory every time somebody opens the picker, for an
       answer with a dozen entries in it. Postgres can do the dedup: strip the
       last path segment and DISTINCT. The result set is the number of folders.
       `.derived` paths never appear here — derivatives are not Upload rows. */
    prisma.$queryRaw<{ dir: string }[]>`
      SELECT DISTINCT regexp_replace("fileUrl", '/[^/]*$', '') AS dir
        FROM "Upload"
       WHERE "eventId" = ${eventId}
    `
  ]);

  const paths = new Set<string>();
  const add = (raw: string) => {
    const segments = splitFolderSegments(raw);
    /* Each ancestor as well as the leaf: a file at "Firm/Ravi/Day 1/Stage" is
       evidence that "Firm/Ravi/Day 1" exists too, and a tree missing its middle
       is a tree that cannot be drawn. */
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const path = segments.slice(0, depth).join("/");
      if (pathRelativeToRoot(path, root) !== null) paths.add(path);
    }
  };

  for (const row of rows) add(row.path);
  // folderFromFileUrl drops the last segment, which the query already did — so
  // it is handed a stand-in file name to drop instead.
  for (const row of dirs) add(folderFromFileUrl(`${row.dir}/file`, eventId));

  // The root itself is where you already are, not a folder you can navigate to.
  if (root) paths.delete(normalizeFolderPath(root));

  return [...paths].sort((a, b) => a.localeCompare(b));
};

export type FolderOwner = {
  createdById: string | null;
  contributorId: string | null;
  /** The link a contributor came through, so the per-link ceiling can be read. */
  linkId?: string | null;
};

/**
 * Create one folder under `root`, from a parent expressed relative to that root.
 *
 * Returns the Response to send on refusal, so the reason travels with it.
 * Idempotent: creating a folder that is already there returns the same path
 * rather than a conflict — two tabs, or a retried request, must not be an error.
 */
export const createFolder = async (opts: {
  eventId: string;
  root: string | null;
  parent: unknown;
  name: unknown;
  owner: FolderOwner;
}): Promise<{ path: string; relative: string } | Response> => {
  const { eventId, root, owner } = opts;

  const rawName = typeof opts.name === "string" ? opts.name.trim() : "";
  if (!rawName) return Response.json({ error: "Give the folder a name" }, { status: 400 });

  const name = sanitizeSegment(rawName);
  if (name === "_" && !/[a-zA-Z0-9]/.test(rawName)) {
    return Response.json({ error: "That folder name can't be used" }, { status: 400 });
  }

  const parent = typeof opts.parent === "string" ? opts.parent : "";
  const relative = [...splitFolderSegments(parent), name].join("/");
  const path = pathUnderRoot(root, relative);

  if (splitFolderSegments(path).length > MAX_FOLDER_DEPTH) {
    return Response.json({ error: "Folders can't be nested that deep" }, { status: 400 });
  }

  /* Belt and braces. pathUnderRoot builds from the root's own segments so this
     cannot fail, but a folder that escaped its root would be a folder one firm
     could create inside another's, and the check costs nothing. */
  if (pathRelativeToRoot(path, root) === null) {
    return Response.json({ error: "That folder is outside your space" }, { status: 400 });
  }

  const existing = await prisma.mediaFolder.findUnique({
    where: { eventId_path: { eventId, path } },
    select: { id: true }
  });
  if (existing) return { path, relative };

  /* Counted per creator rather than per event: an event legitimately holds many
     folders across many firms, but one contributor minting hundreds is someone
     hammering the endpoint, not someone organising a shoot. */
  const mine = await prisma.mediaFolder.count({
    where: {
      eventId,
      ...(owner.contributorId
        ? { contributorId: owner.contributorId }
        : { createdById: owner.createdById, contributorId: null })
    }
  });
  if (mine >= MAX_FOLDERS_PER_CREATOR) {
    return Response.json({ error: "You've created as many folders as this event allows" }, { status: 429 });
  }

  /* ...and the ceiling for the link as a whole. Minting another contributor is
     free to anyone holding the link, so a per-contributor cap on its own caps
     nothing. */
  if (owner.linkId) {
    const perLink = await prisma.mediaFolder.count({
      where: { eventId, contributor: { linkId: owner.linkId } }
    });
    if (perLink >= MAX_FOLDERS_PER_LINK) {
      return Response.json(
        { error: "This link has created as many folders as it is allowed" },
        { status: 429 }
      );
    }
  }

  try {
    await prisma.mediaFolder.create({
      data: { eventId, path, createdById: owner.createdById, contributorId: owner.contributorId }
    });
  } catch (error) {
    // Lost a race with an identical create — the folder exists, which is the point.
    if ((error as { code?: string }).code !== "P2002") throw error;
  }

  return { path, relative };
};
