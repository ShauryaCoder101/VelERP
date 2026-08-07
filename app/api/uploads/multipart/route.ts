import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getProfile } from "../../../../lib/storage";
import { getRequestUser } from "../../../../lib/rbac-server";
import { buildUploadKey } from "../../../../lib/uploadKey";

/* Multipart upload for anything large enough that losing it midway hurts.
 *
 * A single presigned PUT is all-or-nothing: a dropped connection at 900MB of a
 * 1GB file means starting over, and it caps out at 5GB regardless. Splitting the
 * file lets a failed part be retried on its own, so a blip costs one chunk
 * rather than the whole upload.
 *
 * The browser drives it; this route only mints signatures and finalises. */

const PART_EXPIRY = 6 * 60 * 60; // long uploads must outlive their signatures

export async function POST(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const body = await request.json();
  const profile = getProfile(body.purpose === "media" ? "media" : "document");
  if (!profile) return Response.json({ error: "Storage is not configured" }, { status: 500 });

  const { client, bucket, publicBaseUrl } = profile;

  switch (body.action) {
    /* Reserve the key and open the upload. */
    case "create": {
      const key = buildUploadKey(body.eventId ?? "general", body.relativePath ?? "", body.fileName ?? "upload");
      const created = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: body.fileType || "application/octet-stream"
        })
      );
      return Response.json({
        uploadId: created.UploadId,
        key,
        fileUrl: `${publicBaseUrl}/${key}`
      });
    }

    /* Sign a batch of part slots in one round trip. */
    case "sign": {
      const parts: number[] = Array.isArray(body.partNumbers) ? body.partNumbers.slice(0, 1000) : [];
      const urls: Record<number, string> = {};
      await Promise.all(
        parts.map(async (partNumber) => {
          urls[partNumber] = await getSignedUrl(
            client,
            new UploadPartCommand({
              Bucket: bucket,
              Key: body.key,
              UploadId: body.uploadId,
              PartNumber: partNumber
            }),
            { expiresIn: PART_EXPIRY }
          );
        })
      );
      return Response.json({ urls });
    }

    /* Stitch the parts together. Order matters, so the client's list is sorted. */
    case "complete": {
      const parts = (Array.isArray(body.parts) ? body.parts : [])
        .map((p: any) => ({ PartNumber: Number(p.partNumber), ETag: String(p.etag) }))
        .sort((a: any, b: any) => a.PartNumber - b.PartNumber);

      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: body.key,
          UploadId: body.uploadId,
          MultipartUpload: { Parts: parts }
        })
      );
      return Response.json({ fileUrl: `${publicBaseUrl}/${body.key}` });
    }

    /* Discards the parts of an upload that never finished. Nothing that was
       ever a complete object is touched. Without this, abandoned parts sit in
       the bucket being billed. */
    case "abort": {
      await client
        .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: body.key, UploadId: body.uploadId }))
        .catch(() => {});
      return Response.json({ ok: true });
    }

    default:
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
}
