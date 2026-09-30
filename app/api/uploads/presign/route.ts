import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getProfile } from "../../../../lib/storage";
import { getUploader } from "../../../../lib/rbac-server";
import { buildUploadKey, derivativeKeyFor, type Derivative } from "../../../../lib/uploadKey";
import { MULTIPART_THRESHOLD } from "../../../../lib/upload-client";
import {
  allocateQuota,
  hasEventAccess,
  releaseQuota,
  PREVIEW_MAX_BYTES,
  THUMB_MAX_BYTES
} from "../../../../lib/photographers";
import { signReservation } from "../../../../lib/uploadReservation";

/* A signed Content-Length is the whole enforcement mechanism.
 *
 * R2 rejects a PUT whose body is not exactly the length signed into the URL
 * (403). So the size a photographer declares here is the size they can actually
 * upload — which is what makes it safe to charge that size against their quota
 * before a single byte moves. Without the signed length the declaration would
 * be a suggestion. */

const MAX_URL_TTL = 60 * 60;

const positiveSafeInt = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
};

export async function POST(request: Request) {
  const uploader = await getUploader(request);
  if (!uploader) return new Response("Forbidden", { status: 403 });

  const body = await request.json();
  const purpose = body.purpose === "media" ? "media" : "document";
  const eventId = String(body.eventId ?? "general");

  /* Photographers are third parties: media only, and only into an event an
     employee has explicitly handed them. */
  if (uploader.isPhotographer) {
    if (purpose !== "media") {
      return Response.json({ error: "You can only upload event media" }, { status: 403 });
    }
    if (!(await hasEventAccess(uploader.id, eventId))) {
      return Response.json({ error: "You don't have access to this event" }, { status: 403 });
    }
  }

  /* Bulk event media goes to R2 (zero egress); bills, cost sheets and avatars
     stay on S3. Callers that say nothing get the old behaviour. */
  const profile = getProfile(purpose);
  if (!profile) {
    return Response.json({ error: "Storage is not configured" }, { status: 500 });
  }

  const fileType = body.fileType || "application/octet-stream";

  /* fileSize is required of photographers and optional for employees, whose
     existing callers predate it. Absent, the original goes as a single PUT with
     no signed length — exactly today's behaviour. */
  let fileSize: number | null = null;
  if (body.fileSize !== undefined && body.fileSize !== null) {
    fileSize = positiveSafeInt(body.fileSize);
    if (fileSize === null) return Response.json({ error: "fileSize is not a valid size" }, { status: 400 });
  }
  if (uploader.isPhotographer && fileSize === null) {
    return Response.json({ error: "The file size is missing — please try again" }, { status: 400 });
  }

  /* Deduped: ["thumb","thumb"] would otherwise be charged twice for one slot. */
  const wanted: Derivative[] = ["thumb", "preview"].filter((kind) =>
    (Array.isArray(body.derivatives) ? body.derivatives : []).includes(kind)
  ) as Derivative[];
  const caps: Record<Derivative, number> = { thumb: THUMB_MAX_BYTES, preview: PREVIEW_MAX_BYTES };
  const derivativeSizes: Partial<Record<Derivative, number>> = {};
  for (const kind of wanted) {
    const raw = body.derivativeSizes?.[kind];
    if (raw === undefined || raw === null) {
      if (!uploader.isPhotographer) continue; // legacy employee caller: sign without a length
      return Response.json({ error: `The ${kind} size is missing — please try again` }, { status: 400 });
    }
    const size = positiveSafeInt(raw);
    if (size === null) return Response.json({ error: `The ${kind} size is not valid` }, { status: 400 });
    if (size > caps[kind]) {
      return Response.json({ error: `The ${kind} image is too large` }, { status: 400 });
    }
    derivativeSizes[kind] = size;
  }

  /* Anything over the threshold must go through /api/uploads/multipart, which
     allocates the original's bytes itself. Allocating them here as well would
     double-charge the photographer. */
  const multipart = fileSize !== null && fileSize > MULTIPART_THRESHOLD;

  let allocated = 0;
  if (uploader.isPhotographer) {
    allocated =
      (multipart ? 0 : (fileSize ?? 0)) + wanted.reduce((sum, kind) => sum + (derivativeSizes[kind] ?? 0), 0);
    const quota = await allocateQuota(uploader.id, allocated);
    if (!quota.ok) {
      return Response.json(
        { error: "Upload limit reached", usedBytes: quota.usedBytes, quotaBytes: quota.quotaBytes },
        { status: 403 }
      );
    }
  }

  // relativePath is the folder portion only ("Day 1/Stage"), empty for loose files.
  const key = buildUploadKey(eventId, body.relativePath ?? "", body.fileName ?? "upload");

  /* This key is the one the derivative slots below are signed against, and
     derivativeUrlFor() recovers them from the stored original's URL by applying
     the same pure function. So the original has to land on exactly this key —
     including when it is too big for a single PUT and goes to /api/uploads/
     multipart instead. That route used to call buildUploadKey again and get a
     different timestamp, which is why every file over 16MB has been showing a
     broken thumbnail.

     The reservation carries this key to the multipart route through the browser
     without letting the browser pick it: it is an HMAC over { key, eventId,
     userId, purpose }, so a caller can spend the key it was given and nothing
     else. Always issued, even for single-PUT uploads, so the client has one
     code path and a file that crosses the threshold mid-flight still works. */
  const reservation = signReservation({ key, eventId, userId: uploader.id, purpose });

  const sign = (objectKey: string, contentType: string, contentLength?: number) =>
    getSignedUrl(
      profile.client,
      new PutObjectCommand({
        Bucket: profile.bucket,
        Key: objectKey,
        ContentType: contentType,
        // Signed, so the caller cannot send more bytes than it declared.
        ...(contentLength === undefined ? {} : { ContentLength: contentLength })
      }),
      { expiresIn: MAX_URL_TTL }
    );

  try {
    /* The browser also sends a thumbnail and a preview. Signing their slots in
       the same call keeps it to one round trip per file, which matters when a
       shoot is a few thousand of them. */
    const derivatives: Record<string, { uploadUrl: string; fileUrl: string }> = {};
    for (const kind of wanted) {
      const dKey = derivativeKeyFor(key, kind);
      derivatives[kind] = {
        uploadUrl: await sign(dKey, "image/jpeg", derivativeSizes[kind]),
        fileUrl: `${profile.publicBaseUrl}/${dKey}`
      };
    }

    if (multipart) {
      /* No original slot: the client opens a multipart upload, handing back the
         reservation so that upload lands on this key rather than a new one. */
      return Response.json({ key, reservation, derivatives, multipart: true, storage: profile.id });
    }

    return Response.json({
      uploadUrl: await sign(key, fileType, fileSize ?? undefined),
      fileUrl: `${profile.publicBaseUrl}/${key}`,
      key,
      reservation,
      derivatives,
      multipart: false,
      storage: profile.id
    });
  } catch (error) {
    // The bytes were charged before signing; a failure here must not keep them.
    if (allocated > 0) await releaseQuota(uploader.id, allocated).catch(() => {});
    throw error;
  }
}
