import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3Config, createS3Client } from "../../../../lib/s3";
import { getRequestUser } from "../../../../lib/rbac-server";

const EXPIRES = 60 * 60; // an hour is long enough to browse a shoot
const MAX_BATCH = 300;

/* The bucket is private, so nothing can be rendered from its raw URL —
   every read is a short-lived signed GET minted here. */
const signOne = async (
  client: ReturnType<typeof createS3Client>,
  bucket: string,
  publicBaseUrl: string,
  fileUrl: string
) => {
  const prefix = `${publicBaseUrl}/`;
  if (!fileUrl.startsWith(prefix)) return null;
  const key = decodeURIComponent(fileUrl.slice(prefix.length));
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: EXPIRES });
};

export async function GET(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const config = getS3Config();
  if (!config) return Response.json({ error: "S3 not configured" }, { status: 500 });

  const fileUrl = new URL(request.url).searchParams.get("url");
  if (!fileUrl) return Response.json({ error: "Missing url parameter" }, { status: 400 });

  const client = createS3Client(config);
  const signedUrl = await signOne(client, config.bucket, config.publicBaseUrl, fileUrl);
  if (!signedUrl) return Response.json({ error: "Invalid file URL" }, { status: 400 });

  return Response.json({ signedUrl });
}

/* Batch form. A gallery of 200 photos on Vercel would otherwise be 200
   function invocations; this makes it one. */
export async function POST(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const config = getS3Config();
  if (!config) return Response.json({ error: "S3 not configured" }, { status: 500 });

  const body = await request.json();
  const urls: string[] = Array.isArray(body.urls) ? body.urls.slice(0, MAX_BATCH) : [];

  const client = createS3Client(config);
  const entries = await Promise.all(
    urls.map(async (url) => {
      try {
        return [url, await signOne(client, config.bucket, config.publicBaseUrl, url)] as const;
      } catch {
        return [url, null] as const;
      }
    })
  );

  const signed: Record<string, string> = {};
  for (const [url, value] of entries) {
    if (value) signed[url] = value;
  }

  return Response.json({ signed });
}
