import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { prisma } from "../../../../../../lib/db";
import { getRequestUser } from "../../../../../../lib/rbac-server";
import { getProfile } from "../../../../../../lib/storage";
import { MULTIPART_THRESHOLD } from "../../../../../../lib/upload-client";
import { signReservation } from "../../../../../../lib/uploadReservation";
import { buildArtifactKey, parseArtifactCategory } from "../../../../../../lib/event-artifacts";
import { logUploadFailure } from "../../../../../../lib/upload-health";

/* Authorise one artifact upload.
 *
 * The same two-path shape /api/uploads/presign has, minus everything that
 * exists for third parties — no quota, no ledger, no grant check, no
 * derivatives — because artifacts are internal documents uploaded by employees,
 * and employees have no storage ceiling.
 *
 *   <= MULTIPART_THRESHOLD   one PUT, with the declared length SIGNED into the
 *                            URL so the caller cannot send more bytes than it
 *                            said it would.
 *   >  MULTIPART_THRESHOLD   no PUT slot; the client takes the reservation to
 *                            /api/uploads/multipart, which is what makes the
 *                            object land on THIS key rather than a fresh one.
 *
 * The reservation is an HMAC over { key, eventId, userId, purpose }, so the key
 * travels through the browser without the browser being able to choose it.
 * Purpose "media" is the storage profile, not the kind of file: artifacts share
 * the media bucket (R2, zero egress) and are kept apart from media by their key
 * prefix — see lib/event-artifacts.ts. */

const URL_TTL = 60 * 60; // an hour, as for any other employee upload

/* Zero is a legitimate answer: an empty template or a CSV that exported with no
   rows is still a file somebody wants attached, and refusing it as "the file
   size is missing" sends the employee to retry something that will fail
   identically forever. Only a negative, fractional or absent size is a bad
   request. */
const nonNegativeSafeInt = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
};

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  /* Employees only. getRequestUser returns the anonymous shape for a
     photographer session, so this one call shuts out photographers, clients and
     share-link holders alike. */
  const { id: userId, status } = await getRequestUser(request);
  if (!userId || status !== "ACTIVE") return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id: eventId } = await context.params;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const category = parseArtifactCategory(body.category);
  if (!category) return Response.json({ error: "Pick a category for this file" }, { status: 400 });

  const fileSize = nonNegativeSafeInt(body.fileSize);
  if (fileSize === null) {
    return Response.json({ error: "The file size is missing — please try again" }, { status: 400 });
  }

  const fileName = String(body.fileName ?? "file");
  const fileType = String(body.fileType || "application/octet-stream");

  /* Checked before anything is signed: without the event, registration would
     fail on the foreign key after the bytes had already been uploaded, and the
     employee would see a 500 at the last step of a transfer that worked. */
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true } });
  if (!event) return Response.json({ error: "Event not found" }, { status: 404 });

  const profile = getProfile("media");
  if (!profile) return Response.json({ error: "Storage is not configured" }, { status: 500 });

  const key = buildArtifactKey(eventId, category, fileName);
  const fileUrl = `${profile.publicBaseUrl}/${key}`;
  /* Always issued, on both paths, so the client has one code path and a file
     that crosses the threshold between picking and sending still works. */
  const reservation = signReservation({ key, eventId, userId, purpose: "media" });

  /* `purpose` is echoed back for lib/upload-client.ts uploadFile to pass
     straight to /api/uploads/multipart, which verifies the reservation against
     it. */
  const common = { key, fileUrl, reservation, purpose: "media" as const, storage: profile.id };

  if (fileSize > MULTIPART_THRESHOLD) {
    return Response.json({ ...common, multipart: true });
  }

  try {
    const uploadUrl = await getSignedUrl(
      profile.client,
      new PutObjectCommand({
        Bucket: profile.bucket,
        Key: key,
        ContentType: fileType,
        /* Signed, so the declared size is the size that can actually be sent.
           Omitted for an empty file rather than signed as 0: a signed
           content-length of zero is a header the browser's own PUT may or may
           not reproduce byte for byte, and a signature mismatch there would read
           to the employee as "storage refused the file". Nothing is lost — the
           file has no bytes to constrain. */
        ...(fileSize > 0 ? { ContentLength: fileSize } : {})
      }),
      { expiresIn: URL_TTL }
    );
    return Response.json({ ...common, uploadUrl, multipart: false });
  } catch (error) {
    /* A signing failure is otherwise invisible: the browser reports "upload
       failed" for a file that never got as far as a PUT. */
    logUploadFailure({
      route: "events/artifacts/presign",
      action: "sign",
      userId,
      eventId,
      key,
      error
    });
    throw error;
  }
}
