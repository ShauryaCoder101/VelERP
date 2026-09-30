import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { prisma } from "../../../../../lib/db";
import { resolveForUrl } from "../../../../../lib/storage";
import { isArchived } from "../../../../../lib/archive";
import { verifyShareToken } from "../../../../../lib/shareToken";
import { folderFromFileUrl } from "../../../../../lib/uploadKey";

/* Public endpoint, same grant as GET ../route.ts: the token is the whole
   authorisation and this must check it exactly as strictly.
 *
 * It exists because the browser builds the "download everything" ZIP itself
 * (lib/zip-download.ts), and a 300 GB archive takes longer to write than a
 * presigned URL lives. Signing the set up front would hand out thousands of
 * URLs most of which expire before their turn, so the client comes back for a
 * batch at a time as the ZIP advances.
 *
 * No Content-Disposition: these URLs are read by fetch(), which does not care,
 * and a disposition would only confuse the entry name client-zip records. */

const MAX_IDS = 200;

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const payload = verifyShareToken(token);
  if (!payload) {
    return Response.json({ error: "This link is invalid or has expired." }, { status: 410 });
  }

  /* Same fault-tolerant revocation check as GET: a missing table must not break
     delivery, but a revoked row beats a valid signature. */
  let record: { revokedAt: Date | null } | null = null;
  try {
    record = await prisma.mediaShare.findUnique({ where: { token }, select: { revokedAt: true } });
  } catch {
    record = null;
  }
  if (record?.revokedAt) {
    return Response.json({ error: "This link has been withdrawn." }, { status: 410 });
  }

  const body = await request.json().catch(() => null);
  const ids = Array.isArray(body?.ids)
    ? [...new Set((body.ids as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0))].slice(
        0,
        MAX_IDS
      )
    : [];
  if (ids.length === 0) return Response.json({ urls: {} });

  // The eventId filter is the scope gate: an id from another event simply misses.
  const uploads = await prisma.upload.findMany({
    where: { id: { in: ids }, eventId: payload.e },
    select: { id: true, fileUrl: true, createdAt: true }
  });

  // Never outlive the link itself.
  const remaining = Math.floor((payload.x - Date.now()) / 1000);
  const expiresIn = Math.max(60, Math.min(60 * 60, remaining));

  const signed = await Promise.all(
    uploads.map(async (upload) => {
      if (payload.f) {
        const folder = folderFromFileUrl(upload.fileUrl, payload.e);
        if (folder !== payload.f && !folder.startsWith(`${payload.f}/`)) return null;
      }
      /* A cold original is in Deep Archive; a signed URL for it would come back
         InvalidObjectState mid-ZIP. Omit it and let the client list it as
         not included. */
      if (isArchived(upload.createdAt)) return null;

      const found = resolveForUrl(upload.fileUrl);
      if (!found) return null;
      try {
        const url = await getSignedUrl(
          found.profile.client,
          new GetObjectCommand({ Bucket: found.profile.bucket, Key: found.key }),
          { expiresIn }
        );
        return [upload.id, url] as const;
      } catch {
        return null;
      }
    })
  );

  const urls: Record<string, string> = {};
  for (const entry of signed) if (entry) urls[entry[0]] = entry[1];

  return Response.json({ urls });
}
