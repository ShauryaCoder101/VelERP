import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3Config, createS3Client } from "../../../../lib/s3";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";

export async function GET(request: Request) {
  const { id: userId } = await getRequestUser(request);
  // Allow any authenticated user to view uploaded bills
  if (!userId) {
    return new Response("Forbidden", { status: 403 });
  }

  const config = getS3Config();
  if (!config) {
    return Response.json({ error: "S3 not configured" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const fileUrl = searchParams.get("url");
  if (!fileUrl) {
    return Response.json({ error: "Missing url parameter" }, { status: 400 });
  }

  // Extract the S3 key from the stored public URL
  const prefix = `${config.publicBaseUrl}/`;
  if (!fileUrl.startsWith(prefix)) {
    return Response.json({ error: "Invalid file URL" }, { status: 400 });
  }
  const key = fileUrl.slice(prefix.length);

  const client = createS3Client(config);
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
  });

  const signedUrl = await getSignedUrl(client, command, { expiresIn: 60 * 15 }); // 15 min

  return Response.json({ signedUrl });
}
