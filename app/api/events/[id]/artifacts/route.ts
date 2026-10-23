import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../../../lib/db";
import { getRequestUser } from "../../../../../lib/rbac-server";
import type { Role } from "../../../../../lib/rbac";
import { getProfile, resolveForUrl } from "../../../../../lib/storage";
import {
  ARTIFACT_CATEGORY_LIST,
  canDeleteArtifact,
  isArtifactKey,
  normalizeFileType,
  parseArtifactCategory
} from "../../../../../lib/event-artifacts";
import { logUploadFailure } from "../../../../../lib/upload-health";

/* Event artifacts: list and register.
 *
 * Employees only, every one of them, read and write — which is the whole access
 * rule for seeing and uploading. Deletion is the only thing that narrows, and
 * it lives in ./[artifactId]/route.ts.
 *
 * getRequestUser is what shuts the door on everyone else: it returns the
 * anonymous shape for a photographer session (see lib/rbac-server.ts), and
 * clients and share-link holders have no session at all. */

/* What the UI renders, and the only shape either verb returns. `size` rather
   than `sizeBytes` so nothing downstream has to remember that the column is a
   BigInt. */
const artifactSelect = {
  id: true,
  category: true,
  fileName: true,
  fileType: true,
  sizeBytes: true,
  createdAt: true,
  uploadedById: true,
  uploadedBy: { select: { id: true, name: true } }
} as const;

type ArtifactRow = Prisma.EventArtifactGetPayload<{ select: typeof artifactSelect }>;
type Viewer = { id: string; role: Role };

const serialize = (row: ArtifactRow, viewer: Viewer) => ({
  id: row.id,
  category: row.category,
  fileName: row.fileName,
  fileType: row.fileType,
  size: row.sizeBytes === null ? null : Number(row.sizeBytes),
  uploadedBy: { id: row.uploadedBy.id, name: row.uploadedBy.name },
  createdAt: row.createdAt,
  canDelete: canDeleteArtifact(viewer, row)
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: userId, role, status } = await getRequestUser(request);
  if (!userId || status !== "ACTIVE") return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id: eventId } = await context.params;

  const rows = await prisma.eventArtifact.findMany({
    where: { eventId, deletedAt: null },
    select: artifactSelect,
    orderBy: { createdAt: "desc" }
  });

  /* The categories come from the server so the labels and their order live in
     one place (lib/event-artifacts.ts) rather than being retyped in the UI. */
  return Response.json({
    categories: ARTIFACT_CATEGORY_LIST,
    artifacts: rows.map((row) => serialize(row, { id: userId, role }))
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: userId, role, status } = await getRequestUser(request);
  if (!userId || status !== "ACTIVE") return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id: eventId } = await context.params;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const category = parseArtifactCategory(body.category);
  if (!category) return Response.json({ error: "Pick a category for this file" }, { status: 400 });

  const claimedUrl = String(body.fileUrl ?? "");
  /* Bounded: the display name is stored verbatim (the key is the sanitised one)
     and no real file name is longer than this. */
  const fileName = String(body.fileName ?? "file").slice(0, 255).trim() || "file";
  /* Normalised, not trusted: this value is later signed into a storage response
     as Content-Type — see lib/event-artifacts.ts. */
  const fileType = normalizeFileType(body.fileType);

  /* The URL arrives from the browser, so it is a claim rather than a fact.
     Three things have to hold before it becomes a row:

     1. it resolves to one of our buckets at all;
     2. that bucket is the MEDIA bucket — resolveForUrl routes by prefix across
        every profile, so without this a documents-bucket URL under the same key
        path would pass. (With R2 unconfigured getProfile("media") IS the S3
        profile and the check correctly becomes a no-op: one bucket holds both.)
     3. the key is one presign minted for THIS event and THIS category —
        otherwise an employee could attach another event's file, or file a deck
        under a category it was not uploaded to, and the key would stop
        describing the object.

     Then the row is keyed on the url rebuilt from the resolved key, never on the
     string that arrived: what is authorised and what is stored have to be the
     same value. */
  /* resolveForUrl runs decodeURIComponent, which THROWS on a malformed %-escape
     ("100%-done.pdf" sent by a non-browser client), and this is the one call
     site handed an unvalidated string. Uncaught it escapes as a 500 HTML page
     instead of the JSON the client reads its message from, for a request that is
     simply bad input. Contained the same way /api/uploads/view does. */
  let resolved: ReturnType<typeof resolveForUrl> = null;
  try {
    resolved = resolveForUrl(claimedUrl);
  } catch {
    resolved = null;
  }
  if (!resolved) return Response.json({ error: "That file is not in our storage" }, { status: 400 });
  if (resolved.profile !== getProfile("media")) {
    return Response.json({ error: "That file is not in our storage" }, { status: 400 });
  }
  /* Not just "under the prefix" but "of the shape presign mints" — see
     isArtifactKey. A prefix test admits anything nested below it, and a key
     nobody minted is a key whose object nobody uploaded. */
  if (!isArtifactKey(eventId, category, resolved.key)) {
    return Response.json({ error: "That file does not belong to this event" }, { status: 400 });
  }

  /* REBUILT from the resolved pieces, never the caller's string — and this is
     the value stored, compared and unique-indexed from here down.
     resolveForUrl decodes the key, so the string that was AUTHORISED above and
     the string the row is keyed on would otherwise be different things:
     `<base>/%61rtifacts/<event>/PPT/<stamp>-deck.pptx` decodes to another
     employee's exact key, passes every check above, and is a distinct string, so
     the idempotency read misses it and the unique index accepts it. The second
     row's uploader is then whoever sent it — which hands them canDelete, and a
     DeleteObject, on a file they did not upload. Canonicalising collapses every
     spelling of one key onto one row.
     Our own keys contain nothing decodeURIComponent or encodeURI would change
     (sanitizeSegment leaves only [A-Za-z0-9._ -]), so this round-trips. */
  const fileUrl = `${resolved.profile.publicBaseUrl}/${resolved.key}`;

  const viewer = { id: userId, role };

  /* Idempotent on (event, URL): a retry after a timeout or a double-clicked
     Upload must not produce a second row for one object. Unique-indexed as
     well, so the race is caught below rather than only here. */
  const already = await prisma.eventArtifact.findFirst({
    where: { eventId, fileUrl },
    select: { ...artifactSelect, deletedAt: true }
  });
  if (already) {
    /* The object has been deleted from storage under this row, so handing the
       row back as a live artifact would put a file in the list that cannot be
       opened. Only reachable by a registration retried across a deletion. */
    if (already.deletedAt) {
      return Response.json({ error: "That file was deleted" }, { status: 409 });
    }
    return Response.json(serialize(already, viewer), { status: 201 });
  }

  /* The object must actually exist — otherwise the list fills with rows
     pointing at nothing — and the HEAD is also where the size comes from. */
  let sizeBytes: bigint | null = null;
  try {
    const head = await resolved.profile.client.send(
      new HeadObjectCommand({ Bucket: resolved.profile.bucket, Key: resolved.key })
    );
    sizeBytes = typeof head.ContentLength === "number" ? BigInt(head.ContentLength) : null;
  } catch (error) {
    logUploadFailure({
      route: "events/artifacts",
      action: "register:head",
      userId,
      eventId,
      key: resolved.key,
      error
    });
    /* Two answers, because the client acts on them differently: 422 = the
       object genuinely is not there, so send it again; 503 = we could not ask
       storage, so retry THIS call and keep the bytes already sent. The same
       split /api/uploads makes. */
    const missing =
      (error as { name?: string }).name === "NotFound" ||
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
    return missing
      ? Response.json({ error: "That file did not finish uploading" }, { status: 422 })
      : Response.json({ error: "Couldn't check the file in storage. Please try again." }, { status: 503 });
  }

  try {
    const created = await prisma.eventArtifact.create({
      data: { eventId, category, fileUrl, fileName, fileType, sizeBytes, uploadedById: userId },
      select: artifactSelect
    });
    return Response.json(serialize(created, viewer), { status: 201 });
  } catch (error) {
    /* Two registrations of one object racing: both missed the read above, one
       won the unique index. The loser reports the winner's row rather than an
       error — the file is registered either way, which is all the client asked
       for. */
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.eventArtifact.findFirst({ where: { eventId, fileUrl }, select: artifactSelect });
      if (winner) return Response.json(serialize(winner, viewer), { status: 201 });
    }
    /* The event was deleted between the presign and this call — the one way the
       foreign key can fail for a caller that did everything right. Its own
       answer, because a 500 would send the employee back to retry an upload
       that now has nowhere to go. */
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      return Response.json({ error: "Event not found" }, { status: 404 });
    }
    /* The worst failure in the flow: the object is in storage and no row claims
       it, so it is invisible and nothing will ever clean it up. Logged and
       rethrown — the client's retry is idempotent on (event, URL). */
    logUploadFailure({
      route: "events/artifacts",
      action: "register:create",
      userId,
      eventId,
      key: resolved.key,
      error
    });
    throw error;
  }
}
