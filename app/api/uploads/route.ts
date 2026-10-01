import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "../../../lib/db";
import { getRequestUser } from "../../../lib/rbac-server";
import { getUploadActor, keyWithinRoot } from "../../../lib/upload-links";
import { getProfile, resolveForUrl } from "../../../lib/storage";
import { hasEventAccess } from "../../../lib/photographers";
import { settleRegistered } from "../../../lib/upload-charges";

export async function GET(request: Request) {
  // Employees only: a photographer must not be able to enumerate other shoots.
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const eventId = new URL(request.url).searchParams.get("eventId");
  const uploads = await prisma.upload.findMany({
    where: eventId ? { eventId } : undefined,
    include: { event: true, user: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" }
  });
  // BigInt is not JSON-serialisable; sizes are far inside Number's exact range.
  return Response.json(
    uploads.map((u) => ({ ...u, sizeBytes: u.sizeBytes === null ? null : Number(u.sizeBytes) }))
  );
}

export async function POST(request: Request) {
  const uploader = await getUploadActor(request);
  if (!uploader) return new Response("Forbidden", { status: 403 });

  /* Parsed defensively: registration now accepts link credentials, so a
     malformed body can arrive without a session and must be a 400 rather than
     an unhandled throw Next renders as a 500. */
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const eventId = String(body.eventId ?? "");
  const fileUrl = String(body.fileUrl ?? "");

  // A link authorises ONE event; the firm behind it may hold several.
  if (uploader.contributor && uploader.contributor.eventId !== eventId) {
    return Response.json({ error: "This link is for a different event" }, { status: 403 });
  }

  if (uploader.isPhotographer && !(await hasEventAccess(uploader.id, eventId))) {
    return Response.json({ error: "You don't have access to this event" }, { status: 403 });
  }

  /* The URL arrives from the browser, so it is a claim rather than a fact. Two
     things have to be checked before it becomes a row:

     1. the key really lives under this event's prefix — otherwise anyone could
        attach another event's file to an event they do hold, and read it
        through their own gallery;
     2. the object actually exists — otherwise the gallery fills with rows
        pointing at nothing, and we have no size to record. */
  const resolved = resolveForUrl(fileUrl);
  if (!resolved) return Response.json({ error: "That file is not in our storage" }, { status: 400 });

  /* ...and, for a photographer, 3. the bucket is the media bucket.
     resolveForUrl routes by prefix across every profile, so a documents-bucket
     URL under uploads/<eventId>/ passes both checks below. A photographer is
     confined to media by presign and by multipart create, but registration is a
     separate door: a document key they had guessed or seen could be attached to
     an event they hold and then read back through their own gallery, which
     signs whatever the row points at. Compare the profile object itself —
     getProfile memoises, so identity is the comparison — rather than the
     purpose string, which this route never receives.

     If R2 is unconfigured, getProfile("media") IS the S3 profile and this check
     correctly becomes a no-op: one bucket holds both, so there is nothing to
     separate. */
  if (uploader.isPhotographer && resolved.profile !== getProfile("media")) {
    return Response.json({ error: "That file is not in our storage" }, { status: 400 });
  }

  if (!resolved.key.startsWith(`uploads/${eventId}/`) || resolved.key.includes("/.derived/")) {
    return Response.json({ error: "That file does not belong to this event" }, { status: 400 });
  }

  /* ...and 4. the key is inside the caller's own root. Registration is the door
     that turns an object into a row that the gallery, the ZIP and the client
     share link will all serve, and nothing above distinguishes one of a firm's
     contributors from another — they share the firm's user id. Without this, a
     contributor who learned a key (their own derivative path is enough to guess
     the shape) could register a file into someone else's folder. Employees have
     a null root and are unaffected. */
  if (!keyWithinRoot(resolved.key, eventId, uploader.uploadRoot)) {
    return Response.json({ error: "That file is not in your folder" }, { status: 403 });
  }

  /* Registration is idempotent on (event, URL). A retry after a timeout, a
     double-click on Upload, or a resumed batch would otherwise insert a second
     row for the same object — and every employee and client then sees the same
     photo twice in the gallery with no way to tell which row to delete.

     The object is already known to exist, since it was registered once, so the
     HEAD below is skipped as well. */
  /* Registration is what turns a presign charge into a real file, so it is where
     the ledger rows for this key — the original and its two derivative keys —
     are settled as "registered". Conditional on settledAt IS NULL inside, so it
     can never overwrite a settlement a sweep already made.

     Never fatal: a registration that succeeded must not be reported as failed
     because the accounting write did not land. An unsettled row is picked up by
     the sweep, which HEADs the key, finds the object and settles it "landed" —
     the same outcome for the firm's usage. Employees are never charged and have
     no rows to settle. */
  const settle = async () => {
    if (!uploader.isPhotographer) return;
    await settleRegistered(uploader.id, resolved.key).catch(() => {});
  };

  const already = await prisma.upload.findFirst({ where: { eventId, fileUrl } });
  if (already) {
    /* Settled on this path too: a retry after a timeout may be the first call
       that gets far enough to do it, and the file demonstrably exists. */
    await settle();
    return Response.json({
      ...already,
      sizeBytes: already.sizeBytes === null ? null : Number(already.sizeBytes)
    });
  }

  let sizeBytes: bigint | null = null;
  try {
    const head = await resolved.profile.client.send(
      new HeadObjectCommand({ Bucket: resolved.profile.bucket, Key: resolved.key })
    );
    sizeBytes = typeof head.ContentLength === "number" ? BigInt(head.ContentLength) : null;
  } catch {
    return Response.json({ error: "That file did not finish uploading" }, { status: 400 });
  }

  const upload = await prisma.upload.create({
    data: {
      eventId,
      fileUrl,
      fileType: body.fileType,
      // The FIRM owns the file either way — quota, grant and folder are all
      // theirs. contributorId is the only thing that records which of their
      // people actually sent it.
      uploadedBy: uploader.id,
      contributorId: uploader.contributor?.id ?? null,
      sizeBytes
    }
  });
  await settle();
  return Response.json({ ...upload, sizeBytes: sizeBytes === null ? null : Number(sizeBytes) });
}
