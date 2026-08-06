import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getProfile } from "../../../../lib/storage";
import { getRequestUser } from "../../../../lib/rbac-server";
import { buildUploadKey, derivativeKeyFor, type Derivative } from "../../../../lib/uploadKey";

export async function POST(request: Request) {
  // Any signed-in member of staff can add media to an event.
  const { id: userId } = await getRequestUser(request);
  if (!userId) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();

  /* Bulk event media goes to R2 (zero egress); bills, cost sheets and avatars
     stay on S3. Callers that say nothing get the old behaviour. */
  const profile = getProfile(body.purpose === "media" ? "media" : "document");
  if (!profile) {
    return Response.json({ error: "Storage is not configured" }, { status: 500 });
  }

  const fileType = body.fileType || "application/octet-stream";
  const eventId = body.eventId ?? "general";

  // relativePath is the folder portion only ("Day 1/Stage"), empty for loose files.
  const key = buildUploadKey(eventId, body.relativePath ?? "", body.fileName ?? "upload");

  const sign = (objectKey: string, contentType: string) =>
    getSignedUrl(
      profile.client,
      new PutObjectCommand({ Bucket: profile.bucket, Key: objectKey, ContentType: contentType }),
      { expiresIn: 60 * 60 }
    );

  const uploadUrl = await sign(key, fileType);
  const fileUrl = `${profile.publicBaseUrl}/${key}`;

  /* The browser also sends a thumbnail and a preview. Signing their slots in
     the same call keeps it to one round trip per file, which matters when a
     shoot is a few thousand of them. */
  const wanted: Derivative[] = Array.isArray(body.derivatives) ? body.derivatives : [];
  const derivatives: Record<string, { uploadUrl: string; fileUrl: string }> = {};
  for (const kind of wanted) {
    if (kind !== "thumb" && kind !== "preview") continue;
    const dKey = derivativeKeyFor(key, kind);
    derivatives[kind] = {
      uploadUrl: await sign(dKey, "image/jpeg"),
      fileUrl: `${profile.publicBaseUrl}/${dKey}`
    };
  }

  return Response.json({ uploadUrl, fileUrl, key, derivatives, storage: profile.id });
}
