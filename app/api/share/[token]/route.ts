import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { prisma } from "../../../../lib/db";
import { resolveForUrl } from "../../../../lib/storage";
import { isArchived } from "../../../../lib/archive";
import { verifyShareToken } from "../../../../lib/shareToken";
import { folderFromFileUrl, displayNameFromFileUrl, derivativeUrlFor } from "../../../../lib/uploadKey";

/* Public endpoint — no session. The token is the entire authorisation, so this
   deliberately returns only what a client should see: the event's name, dates
   and its media. No vendors, no finances, no contact details, no staff emails. */

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const payload = verifyShareToken(token);
  if (!payload) {
    return Response.json({ error: "This link is invalid or has expired." }, { status: 410 });
  }

  const event = await prisma.event.findUnique({
    where: { id: payload.e },
    select: {
      id: true,
      eventName: true,
      companyName: true,
      fromDate: true,
      toDate: true,
      uploads: {
        select: { id: true, fileUrl: true, fileType: true, createdAt: true },
        orderBy: { createdAt: "asc" }
      }
    }
  });

  if (!event) return Response.json({ error: "This link is no longer available." }, { status: 404 });

  // Never outlive the link itself.
  const remaining = Math.floor((payload.x - Date.now()) / 1000);
  const expiresIn = Math.max(60, Math.min(60 * 60, remaining));

  /* A cross-origin <a download> is ignored by browsers, so the disposition has
     to come from storage itself — signed into the URL. */
  const sign = async (fileUrl: string | null, downloadAs?: string) => {
    if (!fileUrl) return null;
    const found = resolveForUrl(fileUrl);
    if (!found) return null;
    try {
      return await getSignedUrl(
        found.profile.client,
        new GetObjectCommand({
          Bucket: found.profile.bucket,
          Key: found.key,
          ...(downloadAs
            ? { ResponseContentDisposition: `attachment; filename="${downloadAs.replace(/"/g, "")}"` }
            : {})
        }),
        { expiresIn }
      );
    } catch {
      return null;
    }
  };

  const scoped = event.uploads.filter((u) => {
    if (!payload.f) return true;
    const folder = folderFromFileUrl(u.fileUrl, event.id);
    return folder === payload.f || folder.startsWith(`${payload.f}/`);
  });

  const items = await Promise.all(
    scoped.map(async (u) => {
      const name = displayNameFromFileUrl(u.fileUrl);
      const cold = isArchived(u.createdAt);

      /* Thumbnails and previews are never archived, so a client can always browse.
         Originals from a cold event are not offered for download here — restoring
         from Deep Archive takes 12-48h and has to be requested by staff. */
      const [thumb, preview, original, download] = await Promise.all([
        sign(derivativeUrlFor(u.fileUrl, "thumb")),
        sign(derivativeUrlFor(u.fileUrl, "preview")),
        cold ? Promise.resolve(null) : sign(u.fileUrl),
        cold ? Promise.resolve(null) : sign(u.fileUrl, name)
      ]);

      return {
        id: u.id,
        name,
        fileType: u.fileType,
        folder: folderFromFileUrl(u.fileUrl, event.id),
        archived: cold,
        thumb,
        preview,
        original,
        download
      };
    })
  );

  return Response.json({
    event: {
      name: event.eventName,
      company: event.companyName,
      fromDate: event.fromDate,
      toDate: event.toDate
    },
    folder: payload.f,
    expires: payload.x,
    items
  });
}
