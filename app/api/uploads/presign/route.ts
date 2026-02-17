import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, getS3Bucket, getPublicBaseUrl } from "../../../../lib/s3";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";

const sanitizeFileName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

export async function POST(request: Request) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 3) && role !== "Photographer") {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const fileName = sanitizeFileName(body.fileName ?? "upload");
  const fileType = body.fileType ?? "application/octet-stream";
  const eventId = body.eventId ?? "general";

  const bucket = getS3Bucket();
  const key = `uploads/${eventId}/${Date.now()}-${fileName}`;
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: fileType
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 60 * 10 });
  const fileUrl = `${getPublicBaseUrl()}/${key}`;

  return Response.json({ uploadUrl, fileUrl, key });
}
