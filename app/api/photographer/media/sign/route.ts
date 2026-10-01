import { getUploader } from "../../../../../lib/rbac-server";
import { hasEventAccess } from "../../../../../lib/photographers";
import { signMediaDownloads } from "../../../../../lib/media-items";

/* Batch download URLs for the photographer gallery, the session-authenticated
 * twin of app/api/share/[token]/sign. The browser builds the ZIP itself and
 * comes back for a batch at a time, so the gate has to be re-checked on every
 * call — a grant revoked mid-download stops the next batch.
 *
 * Read-only, like the gallery it feeds: a photographer may view and share the
 * media of a granted event, never delete it. */

/** Same hour as the gallery's URLs; a ZIP batch is minutes, not hours. */
const URL_TTL_SECONDS = 60 * 60;

export async function POST(request: Request) {
  const uploader = await getUploader(request);
  if (!uploader) return new Response("Forbidden", { status: 403 });
  if (!uploader.isPhotographer) {
    return Response.json({ error: "This is for photographer accounts" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const eventId = typeof body?.eventId === "string" ? body.eventId : "";
  if (!eventId) return Response.json({ error: "Missing eventId" }, { status: 400 });

  if (!(await hasEventAccess(uploader.id, eventId))) {
    return Response.json({ error: "You don't have access to this event" }, { status: 403 });
  }

  const ids = Array.isArray(body?.ids) ? (body.ids as unknown[]).filter((v): v is string => typeof v === "string") : [];

  const urls = await signMediaDownloads({ eventId, folder: null, ids, expiresIn: URL_TTL_SECONDS });
  return Response.json({ urls });
}
