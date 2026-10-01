import { signMediaDownloads } from "../../../../../../../lib/media-items";
import { contributorContext } from "../../../../_public";

/* Batch download URLs for the link gallery — the token-and-credential twin of
 * /api/photographer/media/sign.
 *
 * The browser builds the ZIP itself and comes back for a batch at a time, so
 * every call re-runs the whole gate: a link closed halfway through a download
 * stops the next batch rather than letting an hour-old page finish the set.
 *
 * Scope is the firm's folder, same as the gallery. An id from outside it — or
 * from another event — simply misses; signMediaDownloads filters on both. */

const URL_TTL_SECONDS = 60 * 60;

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  const resolved = await contributorContext(request, token);
  if (resolved instanceof Response) return resolved;
  const { actor, link } = resolved;

  const body = await request.json().catch(() => null);
  const ids = Array.isArray(body?.ids)
    ? (body.ids as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  const urls = await signMediaDownloads({
    eventId: link.link.eventId,
    folder: actor.viewRoot,
    ids,
    expiresIn: URL_TTL_SECONDS
  });

  return Response.json({ urls });
}
