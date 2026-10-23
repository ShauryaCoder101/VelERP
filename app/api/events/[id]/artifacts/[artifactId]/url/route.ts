import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { prisma } from "../../../../../../../lib/db";
import { getRequestUser } from "../../../../../../../lib/rbac-server";
import { resolveForUrl } from "../../../../../../../lib/storage";
import { isInlineViewableType, normalizeFileType } from "../../../../../../../lib/event-artifacts";

/* Buckets are private, so nothing is readable from a stored URL: every read is
   a short-lived signed GET minted here, and the profile is chosen from the
   stored URL (lib/storage.ts resolveForUrl) rather than from configuration.

   Short, because this is a document the browser fetches the moment it is handed
   over — a click on View or Download — not a gallery of two hundred thumbnails
   that has to stay valid while someone scrolls. Storage checks expiry at
   request start, so a slow download that began in time still finishes. */
const EXPIRES = 10 * 60;

/* Both forms, because neither alone is enough: `filename` is the ASCII fallback
   old clients read, `filename*` is what every current browser prefers and is
   the only one that survives a Hindi or accented file name.

   The fallback is ASCII by construction, not merely de-quoted: RFC 6266 reserves
   `filename=` for ASCII, and the whole header value is signed into the URL and
   echoed back by storage as a response header that must survive a latin-1 round
   trip — so a Devanagari deck name belongs in `filename*` only, with the
   fallback carrying underscores. Quotes, backslashes and control characters
   cannot appear either, so the parameter cannot be broken out of. */
const disposition = (mode: "attachment" | "inline", fileName: string) => {
  const trimmed = fileName.trim() || "file";
  const ascii = trimmed.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").trim() || "file";
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(trimmed)}`;
};

/**
 * A signed URL for one artifact.
 *
 * mode=download  attachment, under the name the uploader gave it. Without the
 *                disposition the browser would display the file instead of
 *                saving it — `download` on a cross-origin anchor is ignored, so
 *                it has to be signed into the URL (the same thing
 *                /api/uploads/view does for photos).
 * mode=view      inline, and ONLY for the types isInlineViewableType allows —
 *                PDFs and inert raster images. Anything else asked for inline is
 *                answered with an attachment instead of being refused: the file
 *                is still perfectly fine to hand over, it just must not be
 *                RENDERED on the storage origin. The UI asks the same question
 *                before it offers View, but this endpoint is reachable directly,
 *                so the check has to live here as well.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; artifactId: string }> }
) {
  // Employees only — the anonymous shape getRequestUser returns for a
  // photographer session fails this, as does no session at all.
  const { id: userId, status } = await getRequestUser(request);
  if (!userId || status !== "ACTIVE") return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id: eventId, artifactId } = await context.params;
  const mode = new URL(request.url).searchParams.get("mode") === "view" ? "view" : "download";

  // Scoped by BOTH ids: an artifact id from another event is not reachable
  // through this event's URL.
  const artifact = await prisma.eventArtifact.findFirst({
    where: { id: artifactId, eventId, deletedAt: null },
    select: { fileUrl: true, fileName: true, fileType: true }
  });
  if (!artifact) return Response.json({ error: "That file no longer exists" }, { status: 404 });

  const resolved = resolveForUrl(artifact.fileUrl);
  if (!resolved) return Response.json({ error: "That file is not in our storage" }, { status: 400 });

  /* An HTML or SVG file asked for inline would be script executing on the host
     that holds every event's files, and fileType is the registering browser's
     claim. So "view" is a request, and the allow-list is the answer. */
  const inline = mode === "view" && isInlineViewableType(artifact.fileType);
  /* Normalised for the same reason it was normalised at registration: it is
     signed into the URL and comes back as a response header. */
  const contentType = normalizeFileType(artifact.fileType);

  try {
    const url = await getSignedUrl(
      resolved.profile.client,
      new GetObjectCommand({
        Bucket: resolved.profile.bucket,
        Key: resolved.key,
        ResponseContentDisposition: disposition(inline ? "inline" : "attachment", artifact.fileName),
        /* Pinned from the row rather than trusted from the object: an object
           stored with a generic octet-stream type would download even in view
           mode, and the row is where the type the uploader's browser reported
           actually lives. */
        ResponseContentType: contentType
      }),
      { expiresIn: EXPIRES }
    );
    return Response.json({ url });
  } catch {
    return Response.json({ error: "Couldn't open that file. Please try again." }, { status: 503 });
  }
}
