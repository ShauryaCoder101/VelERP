import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "../../../lib/db";
import { getRequestUser, getUploader } from "../../../lib/rbac-server";
import { resolveForUrl } from "../../../lib/storage";
import { hasEventAccess } from "../../../lib/photographers";

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
  const uploader = await getUploader(request);
  if (!uploader) return new Response("Forbidden", { status: 403 });

  const body = await request.json();
  const eventId = String(body.eventId ?? "");
  const fileUrl = String(body.fileUrl ?? "");

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
  if (!resolved.key.startsWith(`uploads/${eventId}/`) || resolved.key.includes("/.derived/")) {
    return Response.json({ error: "That file does not belong to this event" }, { status: 400 });
  }

  /* Registration is idempotent on (event, URL). A retry after a timeout, a
     double-click on Upload, or a resumed batch would otherwise insert a second
     row for the same object — and every employee and client then sees the same
     photo twice in the gallery with no way to tell which row to delete.

     The object is already known to exist, since it was registered once, so the
     HEAD below is skipped as well. */
  const already = await prisma.upload.findFirst({ where: { eventId, fileUrl } });
  if (already) {
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
      uploadedBy: uploader.id,
      sizeBytes
    }
  });
  return Response.json({ ...upload, sizeBytes: sizeBytes === null ? null : Number(sizeBytes) });
}
