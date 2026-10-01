import { getUploader } from "../../../lib/rbac-server";
import { hasEventAccess } from "../../../lib/photographers";
import { firmFolderName } from "../../../lib/upload-links";
import { createFolder, listFolders } from "../upload-links/_folders";

/* Folders for a signed-in uploader: the firm's main login, or an employee.
 *
 * Deliberately getUploader and not getUploadActor. The link headers are the
 * credential of someone with no account, and they have their own endpoints under
 * /api/upload-links/public/[token]; letting them in here as well would be a
 * second way to reach the same table, with the root restriction written out a
 * second time. One of the two copies would eventually be the wrong one.
 *
 *   firm main login   root = its own folder. It may look anywhere inside that
 *                     folder, including into what its link users have sent, and
 *                     create folders anywhere inside it.
 *   employee          no root. The event is theirs.
 *
 * Nothing here renames, moves or deletes a folder. Creating is additive and a
 * folder with files in it is only a key prefix anyway — "deleting" one would
 * mean deleting the files, which no photographer-reachable code may ever do. */

const forbidden = () => new Response("Forbidden", { status: 403 });

type Caller = { id: string; root: string | null; isPhotographer: boolean };

/* Resolve the caller against one event, returning the Response to send when
   neither branch holds so the reason travels with the refusal. */
const callerFor = async (request: Request, eventId: string): Promise<Caller | Response> => {
  const uploader = await getUploader(request);
  if (!uploader) return forbidden();

  if (!uploader.isPhotographer) {
    return { id: uploader.id, root: null, isPhotographer: false };
  }

  if (uploader.status !== "ACTIVE") return forbidden();
  if (!(await hasEventAccess(uploader.id, eventId))) {
    return Response.json({ error: "You don't have access to this event" }, { status: 403 });
  }

  const folder = await firmFolderName(uploader.id);
  if (folder === null) return forbidden();
  return { id: uploader.id, root: folder, isPhotographer: true };
};

export async function GET(request: Request) {
  const eventId = new URL(request.url).searchParams.get("eventId");
  if (!eventId) return Response.json({ error: "Missing eventId" }, { status: 400 });

  const caller = await callerFor(request, eventId);
  if (caller instanceof Response) return caller;

  /* uploadRoot and viewRoot are the same for the main login: the firm folder is
     both what it may fill and what it may see. They are separate fields because
     a contributor's are not — theirs is one folder inside the other — and the
     picker reads the same two names from both endpoints. */
  return Response.json({
    uploadRoot: caller.root,
    viewRoot: caller.root,
    folders: await listFolders(eventId, caller.root)
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const eventId = typeof body?.eventId === "string" ? body.eventId : "";
  if (!eventId) return Response.json({ error: "Missing eventId" }, { status: 400 });

  /* The gate needs the eventId, so the body is read first. Nothing is written
     before the check, so an unauthorised caller still changes nothing. */
  const caller = await callerFor(request, eventId);
  if (caller instanceof Response) return caller;

  const made = await createFolder({
    eventId,
    root: caller.root,
    parent: body?.parent,
    name: body?.name,
    owner: { createdById: caller.id, contributorId: null }
  });
  if (made instanceof Response) return made;

  return Response.json(made, { status: 201 });
}
