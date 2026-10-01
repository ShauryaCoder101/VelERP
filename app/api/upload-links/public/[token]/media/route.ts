import { buildMediaItems } from "../../../../../../lib/media-items";
import { contributorContext } from "../../../_public";

/* The gallery a link user sees: everything under the firm's folder for this
 * event, with their own marked and every file labelled with who sent it.
 *
 * Scoped to viewRoot, never to the event. The rest of the event — what Velocity
 * staff uploaded, what other firms delivered — is not theirs to browse, and the
 * folder prefix is what keeps it out rather than a filter the UI applies.
 *
 * Read-only, like every other door a third party comes through. */

/** An hour; the page refetches rather than holding URLs. */
const URL_TTL_SECONDS = 60 * 60;

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  const resolved = await contributorContext(request, token);
  if (resolved instanceof Response) return resolved;
  const { actor, contributor, link } = resolved;

  const items = await buildMediaItems({
    eventId: link.link.eventId,
    folder: actor.viewRoot,
    expiresIn: URL_TTL_SECONDS,
    /* The contributor, not the firm: every one of the firm's people uploads as
       the firm, so viewerId here would mark the whole firm's output as theirs. */
    viewerContributorId: contributor.id,
    withUploader: true
  });

  return Response.json({ items });
}
