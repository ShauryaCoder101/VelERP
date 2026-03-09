import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3Config, createS3Client } from "../../../../lib/s3";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";

const sanitizeFileName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

export async function POST(request: Request) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 3) && role !== "Photographer") {
    return new Response("Forbidden", { status: 403 });
  }

  const config = getS3Config();
  if (!config) {
    return Response.json({ error: "S3 not configured" }, { status: 500 });
  }

  const body = await request.json();
  const fileName = sanitizeFileName(body.fileName ?? "upload");
  const fileType = body.fileType ?? "application/octet-stream";
  const eventId = body.eventId ?? "general";

  const key = `uploads/${eventId}/${Date.now()}-${fileName}`;
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: fileType
  });

  const client = createS3Client(config);
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 60 * 10 });
  const fileUrl = `${config.publicBaseUrl}/${key}`;

  return Response.json({ uploadUrl, fileUrl, key });
}
