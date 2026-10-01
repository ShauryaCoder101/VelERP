import { createFolder, listFolders } from "../../../_folders";
import { contributorContext } from "../../../_public";

/* Folders, for someone holding an open link.
 *
 * The asymmetry is the point and it is deliberate:
 *
 *   SEE   everything under the firm's folder — their own work and the rest of
 *         the firm's. A second shooter needs to know what the first already
 *         delivered before deciding what to re-shoot.
 *
 *   MAKE  only inside their own folder. `parent` is relative to their root and
 *         the server prepends it, so there is no value the browser can send that
 *         puts a folder in a colleague's space or at the firm's root.
 *
 * Nothing here renames, moves or deletes. A contributor cannot undo their own
 * work, let alone anyone else's — the only code that removes an Upload row is
 * the employee-only event DELETE. */

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  const resolved = await contributorContext(request, token);
  if (resolved instanceof Response) return resolved;
  const { actor, link } = resolved;

  return Response.json({
    uploadRoot: actor.uploadRoot,
    viewRoot: actor.viewRoot,
    folders: await listFolders(link.link.eventId, actor.viewRoot)
  });
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  const resolved = await contributorContext(request, token);
  if (resolved instanceof Response) return resolved;
  const { actor, contributor, link } = resolved;

  const body = await request.json().catch(() => null);

  const made = await createFolder({
    eventId: link.link.eventId,
    root: actor.uploadRoot,
    parent: body?.parent,
    name: body?.name,
    // createdById stays null: a contributor is not a User, and the link's firm
    // is already recoverable through the contributor row.
    owner: { createdById: null, contributorId: contributor.id, linkId: contributor.linkId }
  });
  if (made instanceof Response) return made;

  return Response.json(made, { status: 201 });
}
