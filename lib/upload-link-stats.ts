import { prisma } from "./db";
import { folderFromFileUrl } from "./uploadKey";
import { linkStatus, pathRelativeToRoot, type LinkStatus } from "./upload-links";

/* What came in through a firm's open links, and through its main login.
 *
 * Server-only.
 *
 * "Tracking" here means a question staff and the firm both ask in the same
 * words — who sent what, into which folder, how much of it — so there is one
 * implementation and the two endpoints differ only in who may call them. Two
 * copies would drift, and a firm reading one number while staff read another is
 * the kind of disagreement that ends in someone re-uploading a wedding.
 *
 * Everything is derived from Upload rows. Folders are key prefixes
 * (lib/uploadKey.ts), so the file's own URL says which folder it is in; the
 * MediaFolder rows are unioned in on top purely so a folder somebody created
 * and has not filled yet still shows up as theirs.
 *
 * Queries are batched across links rather than issued per link: a firm with
 * fifty links and a thousand contributors must still be three queries, not
 * three thousand. */

export type FolderStat = {
  path: string;
  files: number;
  bytes: number;
  /* True when the path is NOT inside the root being summarised — a firm's
     uploads from before the firm folder existed, which sit at the event root and
     will stay there because keys are never rewritten. Only `countOutsideRoot`
     callers ever see one.

     It exists because the path alone is ambiguous: "Day 1" at the event root and
     "<firm>/Day 1" inside the firm folder are two different folders in storage,
     and both reduce to "Day 1" once expressed relative to their own root. They
     were being added together, so staff read one row claiming files that are in
     two places — and a firm that re-created its old folder structure inside its
     new folder saw doubled counts with nothing to explain them. */
  outside: boolean;
};

export type ContentStats = {
  files: number;
  bytes: number;
  /** Files sitting directly in the root, not in any folder below it. */
  looseFiles: number;
  /* Every folder below the root that holds files, or that was created and left
     empty — counts are the files DIRECTLY in that folder, not a rolled-up
     subtree, so files === looseFiles + sum(subfolders.files) exactly. */
  subfolders: FolderStat[];
  lastUploadAt: string | null;
};

type StatRow = { fileUrl: string; sizeBytes: bigint | null; createdAt: Date };

/**
 * Summarise uploads against the root they are supposed to live under.
 *
 * `root` null means the event itself (an employee's view). Rows whose key falls
 * outside the root are dropped rather than counted at the root: this is a
 * question about one person's folder, and a stray file elsewhere is not theirs
 * to be billed for in a per-person breakdown.
 *
 * `countOutsideRoot` is for the one caller where dropping them is a lie: a
 * firm's main account, whose uploads from before the firm folder existed sit
 * at the event root. Those are counted where they actually are.
 */
export const summarise = (
  eventId: string,
  root: string | null,
  rows: StatRow[],
  knownFolders: string[] = [],
  opts: { countOutsideRoot?: boolean } = {}
): ContentStats => {
  /* Keyed by BOTH the relative path and whether it is inside the root, because
     the pair is what identifies a folder in storage — see FolderStat.outside.
     NUL cannot occur in a sanitised segment, so it cannot be confused with the
     path itself. */
  const folders = new Map<string, { path: string; files: number; bytes: number; outside: boolean }>();
  const slot = (path: string, outside: boolean) => {
    const id = `${outside ? "1" : "0"}\u0000${path}`;
    const at = folders.get(id);
    if (at) return at;
    const fresh = { path, files: 0, bytes: 0, outside };
    folders.set(id, fresh);
    return fresh;
  };

  for (const path of knownFolders) {
    const rel = pathRelativeToRoot(path, root);
    // null = outside the root; "" = the root itself, which is not a subfolder.
    // A known folder is always inside it: that is what pathRelativeToRoot found.
    if (rel) slot(rel, false);
  }

  let files = 0;
  let bytes = 0;
  let looseFiles = 0;
  let last: Date | null = null;

  for (const row of rows) {
    const where = folderFromFileUrl(row.fileUrl, eventId);
    let rel = pathRelativeToRoot(where, root);
    let outside = false;
    if (rel === null) {
      if (!opts.countOutsideRoot) continue;
      /* Uploaded before the firm had a folder: the key sits at the event root
         with no firm segment in it, and will stay there — keys are never
         rewritten. Counted where it is. Reporting "0 files" for an event
         holding four thousand of them is how staff conclude the footage was
         lost and ask for a re-upload, which then charges the quota twice.

         Marked, though: relative to the EVENT it may well share a name with a
         folder inside the firm folder, and merging the two into one row says
         files are somewhere they are not. */
      rel = pathRelativeToRoot(where, null) ?? "";
      outside = true;
    }

    // Null for rows written before the column existed; counted as a file, no bytes.
    const size = row.sizeBytes === null ? 0 : Number(row.sizeBytes);
    files += 1;
    bytes += size;
    if (last === null || row.createdAt > last) last = row.createdAt;

    if (rel === "") {
      looseFiles += 1;
      continue;
    }
    const at = slot(rel, outside);
    at.files += 1;
    at.bytes += size;
  }

  return {
    files,
    bytes,
    looseFiles,
    subfolders: [...folders.values()]
      // The firm's own folders first, then the strays. Ordered on `outside`
      // before the path so two entries sharing a path are deterministic.
      .sort((a, b) => Number(a.outside) - Number(b.outside) || a.path.localeCompare(b.path)),
    lastUploadAt: last === null ? null : last.toISOString()
  };
};

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** The columns every link view needs. Shared so the two callers select alike. */
export const LINK_SELECT = {
  id: true,
  token: true,
  label: true,
  eventId: true,
  photographerId: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
  lastUsedAt: true,
  event: { select: { id: true, eventName: true } }
} as const;

export type LinkRow = {
  id: string;
  token: string;
  label: string | null;
  eventId: string;
  photographerId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  event: { id: string; eventName: string };
};

export type LinkSummary = {
  id: string;
  token: string;
  label: string | null;
  status: LinkStatus;
  event: { id: string; name: string };
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** How many people have ever opened this link and given a name. */
  contributors: number;
  files: number;
  bytes: number;
  lastUploadAt: string | null;
};

export type ContributorDetail = ContentStats & {
  id: string;
  name: string;
  /** Their folder name inside the firm folder, not the full path. */
  folder: string;
  createdAt: string;
  lastSeenAt: string | null;
};

/* Omit rather than the contract's `contributors: never`: a property typed never
   cannot be given a value, so the object could not be constructed at all. The
   count lives in contributorCount and the per-person rows in `people`. */
export type LinkDetail = Omit<LinkSummary, "contributors"> & {
  contributorCount: number;
  people: ContributorDetail[];
};

const shapeSummary = (
  link: LinkRow,
  counts: { contributors: number; files: number; bytes: number; lastUploadAt: string | null },
  now: Date
): LinkSummary => ({
  id: link.id,
  token: link.token,
  label: link.label,
  status: linkStatus(link, now),
  event: { id: link.event.id, name: link.event.eventName },
  createdAt: link.createdAt.toISOString(),
  expiresAt: link.expiresAt.toISOString(),
  revokedAt: link.revokedAt === null ? null : link.revokedAt.toISOString(),
  lastUsedAt: link.lastUsedAt === null ? null : link.lastUsedAt.toISOString(),
  ...counts
});

const latest = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b);

/**
 * The full picture for a set of links belonging to ONE firm.
 *
 * `firmFolder` is the firm's folder inside every event — a contributor's root is
 * that plus their own folder name, which is what the per-person breakdown is
 * measured against.
 *
 * Three queries regardless of how many links are passed. Note the link's status
 * here is only its own (open / expired / revoked): "paused", which means the
 * firm or its grant went away, is a property of a live request and is decided by
 * resolveOpenLink, not by a tracker that may be listing links across events.
 */
export const linkDetails = async (links: LinkRow[], firmFolder: string): Promise<LinkDetail[]> => {
  const now = new Date();
  if (links.length === 0) return [];

  const people = await prisma.uploadContributor.findMany({
    where: { linkId: { in: links.map((l) => l.id) } },
    select: { id: true, linkId: true, name: true, folderName: true, createdAt: true, lastSeenAt: true },
    orderBy: { createdAt: "asc" }
  });

  const contributorIds = people.map((p) => p.id);
  const [uploads, folders] = await Promise.all([
    contributorIds.length
      ? prisma.upload.findMany({
          where: { contributorId: { in: contributorIds } },
          select: { contributorId: true, fileUrl: true, sizeBytes: true, createdAt: true }
        })
      : Promise.resolve([]),
    contributorIds.length
      ? prisma.mediaFolder.findMany({
          where: { contributorId: { in: contributorIds } },
          select: { contributorId: true, path: true }
        })
      : Promise.resolve([])
  ]);

  const rowsFor = new Map<string, StatRow[]>();
  for (const row of uploads) {
    if (!row.contributorId) continue;
    const at = rowsFor.get(row.contributorId);
    if (at) at.push(row);
    else rowsFor.set(row.contributorId, [row]);
  }

  const foldersFor = new Map<string, string[]>();
  for (const row of folders) {
    if (!row.contributorId) continue;
    const at = foldersFor.get(row.contributorId);
    if (at) at.push(row.path);
    else foldersFor.set(row.contributorId, [row.path]);
  }

  const linkById = new Map(links.map((link) => [link.id, link]));

  const byLink = new Map<string, ContributorDetail[]>();
  for (const person of people) {
    const link = linkById.get(person.linkId);
    if (!link) continue;
    const stats = summarise(
      link.eventId,
      `${firmFolder}/${person.folderName}`,
      rowsFor.get(person.id) ?? [],
      foldersFor.get(person.id) ?? []
    );
    const detail: ContributorDetail = {
      id: person.id,
      name: person.name,
      folder: person.folderName,
      createdAt: person.createdAt.toISOString(),
      lastSeenAt: person.lastSeenAt === null ? null : person.lastSeenAt.toISOString(),
      ...stats
    };
    const at = byLink.get(person.linkId);
    if (at) at.push(detail);
    else byLink.set(person.linkId, [detail]);
  }

  return links.map((link) => {
    const crowd = byLink.get(link.id) ?? [];
    const totals = crowd.reduce(
      (sum, person) => ({
        files: sum.files + person.files,
        bytes: sum.bytes + person.bytes,
        lastUploadAt: latest(sum.lastUploadAt, person.lastUploadAt)
      }),
      { files: 0, bytes: 0, lastUploadAt: null as string | null }
    );
    const { contributors: _drop, ...rest } = shapeSummary(link, { contributors: crowd.length, ...totals }, now);
    return { ...rest, contributorCount: crowd.length, people: crowd };
  });
};

/**
 * The same figures without the per-person breakdown — what a list needs.
 *
 * Aggregated in the database rather than by summarising rows in JS. A list page
 * wants three numbers per link; going through linkDetails for them pulled every
 * Upload row of every contributor of every link into the Node process and threw
 * the breakdown away, which for a firm with a year of weddings is the whole
 * file table for a page that shows a count.
 *
 * The one thing lost by not re-deriving from keys is summarise's root check —
 * a contributor's uploads are confined to their own folder by presign,
 * multipart create and registration alike, so there is nothing for it to
 * exclude here.
 */
export const linkSummaries = async (links: LinkRow[], _firmFolder: string): Promise<LinkSummary[]> => {
  const now = new Date();
  if (links.length === 0) return [];

  const people = await prisma.uploadContributor.findMany({
    where: { linkId: { in: links.map((l) => l.id) } },
    select: { id: true, linkId: true }
  });

  const totals = new Map<string, { contributors: number; files: number; bytes: number; lastUploadAt: string | null }>();
  for (const link of links) totals.set(link.id, { contributors: 0, files: 0, bytes: 0, lastUploadAt: null });

  const linkOf = new Map(people.map((p) => [p.id, p.linkId]));
  for (const person of people) {
    const at = totals.get(person.linkId);
    if (at) at.contributors += 1;
  }

  if (people.length > 0) {
    const grouped = await prisma.upload.groupBy({
      by: ["contributorId"],
      where: { contributorId: { in: people.map((p) => p.id) } },
      _count: { _all: true },
      _sum: { sizeBytes: true },
      _max: { createdAt: true }
    });
    for (const row of grouped) {
      const linkId = row.contributorId === null ? undefined : linkOf.get(row.contributorId);
      const at = linkId === undefined ? undefined : totals.get(linkId);
      if (!at) continue;
      at.files += row._count._all;
      at.bytes += Number(row._sum.sizeBytes ?? 0n);
      at.lastUploadAt = latest(at.lastUploadAt, row._max.createdAt?.toISOString() ?? null);
    }
  }

  return links.map((link) =>
    shapeSummary(link, totals.get(link.id) ?? { contributors: 0, files: 0, bytes: 0, lastUploadAt: null }, now)
  );
};

// ---------------------------------------------------------------------------
// The firm's own login
// ---------------------------------------------------------------------------

export type MainAccountStats = ContentStats & { event: { id: string; name: string } };

/**
 * What the firm's main login uploaded itself, per event — everything with no
 * contributor on it, which is exactly "not through a link".
 */
export const mainAccountStats = async (
  photographerId: string,
  firmFolder: string
): Promise<MainAccountStats[]> => {
  const [uploads, folders] = await Promise.all([
    prisma.upload.findMany({
      where: { uploadedBy: photographerId, contributorId: null },
      select: {
        eventId: true,
        fileUrl: true,
        sizeBytes: true,
        createdAt: true,
        event: { select: { id: true, eventName: true } }
      }
    }),
    prisma.mediaFolder.findMany({
      where: { createdById: photographerId, contributorId: null },
      select: { eventId: true, path: true, event: { select: { id: true, eventName: true } } }
    })
  ]);

  const events = new Map<string, { id: string; name: string }>();
  const rowsFor = new Map<string, StatRow[]>();
  const foldersFor = new Map<string, string[]>();

  for (const row of uploads) {
    events.set(row.eventId, { id: row.event.id, name: row.event.eventName });
    const at = rowsFor.get(row.eventId);
    if (at) at.push(row);
    else rowsFor.set(row.eventId, [row]);
  }
  for (const row of folders) {
    events.set(row.eventId, { id: row.event.id, name: row.event.eventName });
    const at = foldersFor.get(row.eventId);
    if (at) at.push(row.path);
    else foldersFor.set(row.eventId, [row.path]);
  }

  return [...events.entries()]
    .map(([eventId, event]) => ({
      event,
      /* countOutsideRoot: everything this firm uploaded before the firm folder
         existed is outside it, and this is the screen on which staff decide
         whether a shoot arrived. */
      ...summarise(eventId, firmFolder, rowsFor.get(eventId) ?? [], foldersFor.get(eventId) ?? [], {
        countOutsideRoot: true
      })
    }))
    .sort((a, b) => (b.lastUploadAt ?? "").localeCompare(a.lastUploadAt ?? ""));
};
