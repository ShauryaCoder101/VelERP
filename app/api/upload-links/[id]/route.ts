import { prisma } from "../../../../lib/db";
import { getRequestUser, getUploader } from "../../../../lib/rbac-server";
import { firmFolderName } from "../../../../lib/upload-links";
import { LINK_SELECT, linkDetails } from "../../../../lib/upload-link-stats";

/* One link, in full: who has used it, what each of them sent, and where it went.
 *
 * Who may do what:
 *   read    the firm that owns it, and any employee
 *   close   employees only
 *
 * The second line is the same rule as a client share link, for the same reason.
 * A firm that could close its own link could also close the one its uploads are
 * recorded against — and "the link is gone" is indistinguishable from "nothing
 * was ever sent". Closing is soft, so the record survives it either way. */

const forbidden = () => new Response("Forbidden", { status: 403 });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const link = await prisma.uploadLink.findUnique({ where: { id }, select: LINK_SELECT });
  if (!link) return Response.json({ error: "That link no longer exists" }, { status: 404 });

  /* Employee first: getRequestUser returns the anonymous shape for a
     photographer session, so an empty id means "not an employee" rather than
     "not signed in", and the firm is asked for through its own door below. */
  const employee = await getRequestUser(request);
  if (!employee.id) {
    const uploader = await getUploader(request);
    if (!uploader?.isPhotographer || uploader.id !== link.photographerId) return forbidden();
  }

  const folder = await firmFolderName(link.photographerId);
  if (folder === null) return Response.json({ error: "That link no longer exists" }, { status: 404 });

  const [detail] = await linkDetails([link], folder);
  return Response.json(detail);
}

/**
 * Close a link. Soft — revokedAt and who set it — so the contributors, their
 * folders and their files all stay exactly where they are and keep being
 * attributed. Only the URL stops working.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const uploader = await getUploader(request);
  if (!uploader) return forbidden();
  if (uploader.isPhotographer) {
    return Response.json({ error: "Only Velocity staff can close an upload link" }, { status: 403 });
  }

  const employee = await getRequestUser(request);
  if (!employee.id) return forbidden();

  const { id } = await context.params;

  // Guarded on revokedAt still being null so a second call cannot rewrite who
  // closed it, or when.
  const closed = await prisma.uploadLink.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: employee.id }
  });

  if (closed.count === 0) {
    const exists = await prisma.uploadLink.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return Response.json({ error: "That link no longer exists" }, { status: 404 });
  }

  return Response.json({ ok: true });
}
