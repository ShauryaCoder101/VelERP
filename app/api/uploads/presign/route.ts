import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3Config, createS3Client } from "../../../../lib/s3";
import { getRequestUser } from "../../../../lib/rbac-server";
import { buildUploadKey } from "../../../../lib/uploadKey";

export async function POST(request: Request) {
  // Any signed-in member of staff can add media to an event.
  const { id: userId } = await getRequestUser(request);
  if (!userId) {
    return new Response("Forbidden", { status: 403 });
  }

  const config = getS3Config();
  if (!config) {
    return Response.json({ error: "S3 not configured" }, { status: 500 });
  }

  const body = await request.json();
  const fileType = body.fileType || "application/octet-stream";
  const eventId = body.eventId ?? "general";

  // relativePath is the folder portion only ("Day 1/Stage"), empty for loose files.
  const key = buildUploadKey(eventId, body.relativePath ?? "", body.fileName ?? "upload");

  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: fileType
  });

  const client = createS3Client(config);
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 60 * 60 });
  const fileUrl = `${config.publicBaseUrl}/${key}`;

  return Response.json({ uploadUrl, fileUrl, key });
}
