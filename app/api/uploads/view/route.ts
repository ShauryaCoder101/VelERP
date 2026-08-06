import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getProfile, resolveForUrl } from "../../../../lib/storage";
import { isDerivedKey } from "../../../../lib/archive";
import { getRequestUser } from "../../../../lib/rbac-server";

const EXPIRES = 60 * 60; // an hour is long enough to browse a shoot
const MAX_BATCH = 300;

/* Buckets are private, so nothing renders from a raw URL — every read is a
   short-lived signed GET minted here. The bucket is chosen from the stored
   URL, which is how pre-R2 objects keep working untouched. */
const signOne = async (fileUrl: string, archived: boolean) => {
  const found = resolveForUrl(fileUrl);
  if (!found) return null;

  let { profile, key } = found;

  /* A cold original lives at the same key in the archive bucket. Thumbnails are
     never archived, so they always resolve to the hot profile. */
  if (archived && !isDerivedKey(key)) {
    const archive = getProfile("archive");
    if (archive) profile = archive;
  }

  try {
    return await getSignedUrl(profile.client, new GetObjectCommand({ Bucket: profile.bucket, Key: key }), {
      expiresIn: EXPIRES
    });
  } catch {
    return null;
  }
};

export async function GET(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const fileUrl = new URL(request.url).searchParams.get("url");
  if (!fileUrl) return Response.json({ error: "Missing url parameter" }, { status: 400 });

  const signedUrl = await signOne(fileUrl, false);
  if (!signedUrl) return Response.json({ error: "Invalid file URL" }, { status: 400 });

  return Response.json({ signedUrl });
}

/* Batch form. A gallery of 200 photos on Vercel would otherwise be 200
   function invocations; this makes it one. */
export async function POST(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const body = await request.json();
  const urls: string[] = Array.isArray(body.urls) ? body.urls.slice(0, MAX_BATCH) : [];
  const archivedUrls: string[] = Array.isArray(body.archived) ? body.archived : [];
  const cold = new Set(archivedUrls);

  const entries = await Promise.all(
    urls.map(async (url) => [url, await signOne(url, cold.has(url))] as const)
  );

  const signed: Record<string, string> = {};
  for (const [url, value] of entries) {
    if (value) signed[url] = value;
  }

  return Response.json({ signed });
}
