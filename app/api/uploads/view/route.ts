import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getProfile, resolveForUrl } from "../../../../lib/storage";
import { isDerivedKey } from "../../../../lib/archive";
import { getRequestUser } from "../../../../lib/rbac-server";
import { displayNameFromFileUrl } from "../../../../lib/uploadKey";

const EXPIRES = 60 * 60; // an hour is long enough to browse a shoot
const MAX_BATCH = 300;

/* Buckets are private, so nothing renders from a raw URL — every read is a
   short-lived signed GET minted here. The bucket is chosen from the stored
   URL, which is how pre-R2 objects keep working untouched. */
const signOne = async (fileUrl: string, archived: boolean, downloadAs?: string) => {
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
    return await getSignedUrl(
      profile.client,
      new GetObjectCommand({
        Bucket: profile.bucket,
        Key: key,
        /* `download` on a cross-origin anchor is ignored, so a browser handed a
           plain signed URL displays the photo instead of saving it. The
           disposition therefore has to be signed into the URL itself — the same
           thing app/api/share/[token]/route.ts does for client galleries. With
           it, the browser streams the file to disk on its own and nothing is
           buffered in the page. */
        ...(downloadAs
          ? { ResponseContentDisposition: `attachment; filename="${downloadAs.replace(/"/g, "")}"` }
          : {})
      }),
      { expiresIn: EXPIRES }
    );
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
  /* Ignore non-string entries up front: the batch below runs under Promise.all,
     so one bad item that made a helper throw would reject the whole set. */
  const urls: string[] = Array.isArray(body.urls)
    ? body.urls.filter((u: unknown): u is string => typeof u === "string").slice(0, MAX_BATCH)
    : [];
  const archivedUrls: string[] = Array.isArray(body.archived) ? body.archived : [];
  const cold = new Set(archivedUrls);
  /* Opt-in, because the same batch endpoint feeds the gallery: a thumbnail
     signed as an attachment would download instead of rendering in an <img>. */
  const asDownload = body.download === true;

  const entries = await Promise.all(
    urls.map(async (url) => {
      /* displayNameFromFileUrl runs decodeURIComponent, which throws on a
         malformed %-escape. Contain it per URL so one bad URL is simply left
         out of the response instead of 500-ing the whole batch. */
      try {
        const downloadAs = asDownload ? displayNameFromFileUrl(url) : undefined;
        return [url, await signOne(url, cold.has(url), downloadAs)] as const;
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
