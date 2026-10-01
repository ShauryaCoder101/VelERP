import { getUploadActor, resolveOpenLink, type ResolvedLink, type UploadActor } from "../../../lib/upload-links";

/* The gate every public upload-link endpoint passes through.
 *
 * These URLs are reachable by anyone holding the token — that is the whole
 * point of the feature — so the checks are done here once rather than retyped
 * in seven route files where the seventh would forget one.
 *
 * Two separate facts have to hold:
 *
 *   the LINK is live        resolveOpenLink re-reads it on every request, so a
 *                           revoked link, an expired one, a deactivated firm or
 *                           a withdrawn event grant all stop working within one
 *                           request — nobody has to remember to close anything.
 *
 *   the CALLER is known     the contributor headers carry an id and the secret
 *                           their browser kept. The token in the URL and the one
 *                           in the header must resolve to the SAME link, so a
 *                           credential minted on one firm's link can never be
 *                           presented against another's. */

const CLOSED: Record<string, string> = {
  expired: "This upload link has expired. Ask the studio for a new one.",
  revoked: "This upload link has been closed.",
  paused: "This upload link isn't active right now. Ask the studio to check with Velocity."
};

export const linkGone = (status: string) =>
  Response.json({ error: CLOSED[status] ?? "This upload link is no longer open.", status }, { status: 410 });

export const noSuchLink = () => Response.json({ error: "This upload link doesn't exist." }, { status: 404 });

/** The link behind a public token, or the Response explaining why there isn't one. */
export const openLink = async (token: string): Promise<ResolvedLink | Response> => {
  const resolved = await resolveOpenLink(token);
  if (!resolved) return noSuchLink();
  if (resolved.status !== "open") return linkGone(resolved.status);
  return resolved;
};

export type ContributorContext = {
  link: ResolvedLink;
  actor: UploadActor;
  contributor: NonNullable<UploadActor["contributor"]>;
};

/**
 * The same, plus the person: a contributor who has already given their name and
 * whose device still holds the secret.
 *
 * getUploadActor is pinned to this link's event, and the credential is checked
 * against this link — a session cookie cannot stand in for either, so an
 * employee's or the firm's own browser gets 401 here rather than quietly being
 * served as somebody.
 */
export const contributorContext = async (
  request: Request,
  token: string
): Promise<ContributorContext | Response> => {
  const link = await openLink(token);
  if (link instanceof Response) return link;

  // The link is already resolved; handing it over saves getUploadActor doing
  // the same three authorisation queries again on every contributor request.
  const actor = await getUploadActor(request, { eventId: link.link.eventId, link });
  if (!actor?.contributor || actor.contributor.linkId !== link.link.id) {
    return Response.json({ error: "Open the link again and enter your name." }, { status: 401 });
  }

  return { link, actor, contributor: actor.contributor };
};
