import { quotaSummary } from "../../../../../../lib/photographers";
import { pathRelativeToRoot } from "../../../../../../lib/upload-links";
import { contributorContext } from "../../../_public";

/* "Am I still me?" — the first call the upload page makes when a browser comes
 * back holding a secret from a previous visit.
 *
 * It is also the re-check. A contributor's device keeps its credential
 * indefinitely, but the authority behind it is re-read on every request: if the
 * link was closed, has expired, the firm was deactivated or its grant on the
 * event was withdrawn, this answers 410 and the page sends them away instead of
 * letting them upload into a folder nobody is watching any more. */

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  const resolved = await contributorContext(request, token);
  if (resolved instanceof Response) return resolved;
  const { actor, contributor, link } = resolved;

  const quota = await quotaSummary(link.firm.id);

  return Response.json({
    contributor: {
      id: contributor.id,
      name: contributor.name,
      // Their own folder's name, not the full path — the firm folder above it is
      // the viewRoot and the page shows it separately.
      folder: pathRelativeToRoot(contributor.folderPath, actor.viewRoot) ?? contributor.folderPath
    },
    uploadRoot: actor.uploadRoot,
    viewRoot: actor.viewRoot,
    quota: { remainingBytes: Math.max(0, quota.quotaBytes - quota.usedBytes) }
  });
}
