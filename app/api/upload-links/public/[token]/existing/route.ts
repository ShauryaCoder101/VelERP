import { prisma } from "../../../../../../lib/db";
import { pathRelativeToRoot } from "../../../../../../lib/upload-links";
import { displayNameFromFileUrl, folderFromFileUrl } from "../../../../../../lib/uploadKey";
import { contributorContext } from "../../../_public";

/* What have I already uploaded, for someone holding an open link?
 *
 * The same question /api/uploads/existing answers for the firm's own login, and
 * the page uses it for the same reason: a photographer whose batch died over a
 * hotel connection re-drops the same folder, and every file that did land would
 * otherwise go up a second time out of the firm's 1 TB.
 *
 * Scoped to THEIR rows and THEIR folder, not the firm's. The gallery on this
 * page deliberately shows everything the firm delivered — a second shooter needs
 * to know what the first already sent — but that is a list of names and
 * thumbnails the firm chose to share across its own link. This endpoint exists
 * to answer "would this upload be a duplicate", and the only files that could
 * be are the ones this person put in their own folder.
 *
 * Read-only, like every other door a third party comes through. */

/* A guard on the size of the response rather than a limit anyone meets: one
   person's share of one event. */
const MAX_ENTRIES = 100_000;

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  const resolved = await contributorContext(request, token);
  if (resolved instanceof Response) return resolved;
  const { actor, contributor, link } = resolved;

  const eventId = link.link.eventId;

  const rows = await prisma.upload.findMany({
    where: { eventId, contributorId: contributor.id },
    select: { fileUrl: true, sizeBytes: true },
    take: MAX_ENTRIES
  });

  const entries: { path: string; name: string; size: number | null }[] = [];
  for (const row of rows) {
    /* Relative to their own upload root, which is what a queued file's target
       folder is relative to as well. Null means the row is somehow not inside
       their folder — registration will not accept such a key, so this is
       defensive — and it is dropped rather than reported at some other depth,
       where it could only produce a wrong skip. */
    const relative = pathRelativeToRoot(folderFromFileUrl(row.fileUrl, eventId), actor.uploadRoot);
    if (relative === null) continue;
    entries.push({
      path: relative,
      name: displayNameFromFileUrl(row.fileUrl),
      // BigInt is not JSON-serialisable; sizes are far inside Number's exact range.
      size: row.sizeBytes === null ? null : Number(row.sizeBytes)
    });
  }

  return Response.json({ entries });
}
