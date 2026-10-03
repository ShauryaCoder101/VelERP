import { prisma } from "../../../../lib/db";
import { hasEventAccess } from "../../../../lib/photographers";
import { getUploadActor, normalizeFolderPath, pathRelativeToRoot } from "../../../../lib/upload-links";
import { displayNameFromFileUrl, folderFromFileUrl } from "../../../../lib/uploadKey";

/* What have I already uploaded to this event?
 *
 * Asked by the upload page before a batch starts, so a firm re-dropping the
 * same folder after a failed run does not pay for a second copy of every file
 * that did land. The answer is deliberately narrow: this caller's OWN files for
 * ONE event, and only the three facts a client needs to recognise a file it is
 * holding — where it sits, what it is called, how big it is. Nothing about who
 * else uploaded what, and no ids, so the response cannot be turned into a way
 * to enumerate the firm's deliveries, let alone the event's.
 *
 * The firm's main login, not its link users. A contributor has their own
 * endpoint under /api/upload-links/public/[token]/existing, scoped to their own
 * folder and their own rows; serving them here as well would mean writing that
 * scoping out twice, and one of the two copies would eventually be the wrong
 * one. Same reasoning as /api/media-folders.
 *
 * Read-only. */

/* A guard on the size of the response, not a limit anyone is expected to meet:
   the largest event in the system holds a few thousand files. The rows are
   fetched for one event and one uploader, which the (eventId, fileUrl) index
   serves, and only two columns are read. */
const MAX_ENTRIES = 100_000;

const forbidden = () => new Response("Forbidden", { status: 403 });

export async function GET(request: Request) {
  const eventId = new URL(request.url).searchParams.get("eventId");
  if (!eventId) return Response.json({ error: "Missing eventId" }, { status: 400 });

  const actor = await getUploadActor(request, { eventId });
  if (!actor) return forbidden();

  // Link holders go through their own endpoint; see the header.
  if (actor.contributor) return forbidden();
  if (!actor.isPhotographer || actor.status !== "ACTIVE") return forbidden();
  if (!(await hasEventAccess(actor.id, eventId))) {
    return Response.json({ error: "You don't have access to this event" }, { status: 403 });
  }

  /* contributorId NULL: only what the main login itself sent. A contributor's
     files are inside a different folder, so reporting them would never match
     anything the main login is about to upload — it would only be telling the
     firm's office what each of its photographers has delivered through an
     endpoint that exists to skip duplicates. */
  const rows = await prisma.upload.findMany({
    where: { eventId, uploadedBy: actor.id, contributorId: null },
    select: { fileUrl: true, sizeBytes: true },
    take: MAX_ENTRIES
  });

  const root = actor.uploadRoot;

  return Response.json({
    entries: rows.map((row) => {
      const folder = folderFromFileUrl(row.fileUrl, eventId);
      /* Paths are reported relative to the folder the caller uploads INTO, which
         is what the client can compare against a queued file.

         Rows outside the firm folder are reported relative to the EVENT root
         instead. Every file this firm sent before 1 October sits there — the
         per-firm folder is newer than those uploads — so a firm re-dropping
         "ROADSHOW 29 Sept" would otherwise match none of the 396 files of it we
         already hold and upload the lot again. Both forms share one namespace
         on the client, which is correct for the only question being asked:
         have we got this file already. */
      const relative = pathRelativeToRoot(folder, root);
      return {
        path: relative ?? normalizeFolderPath(folder),
        name: displayNameFromFileUrl(row.fileUrl),
        // BigInt is not JSON-serialisable; sizes are far inside Number's exact range.
        size: row.sizeBytes === null ? null : Number(row.sizeBytes)
      };
    })
  });
}
