import { quotaSummary } from "../../../../../lib/photographers";
import { openLink } from "../../_public";

/* What the public upload page shows before anyone has typed their name.
 *
 * No session, no credential — the token is the whole authorisation, so this
 * returns the smallest thing that makes the page usable and nothing else: which
 * studio, which event, when the link shuts, and how much room is left. No
 * client contact details, no staff, no file list, no other event. A link that
 * leaks is then a link to an upload box, not a window into the business.
 *
 * A closed link answers 410 WITH its status, because "expired" and "closed" and
 * "mistyped the URL" need three different things done about them and one
 * "not found" tells a photographer in the field none of them. */

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  const resolved = await openLink(token);
  if (resolved instanceof Response) return resolved;

  const { link, firm, event, status } = resolved;

  /* The firm's single ceiling, which every link shares. A hundred links do not
     buy a hundred terabytes — this is the same number the main login sees. */
  const quota = await quotaSummary(firm.id);

  return Response.json({
    link: { id: link.id, label: link.label, expiresAt: link.expiresAt, status },
    event: {
      id: event.id,
      name: event.eventName,
      company: event.companyName,
      fromDate: event.fromDate,
      toDate: event.toDate
    },
    firm: { name: firm.name, folder: firm.folder },
    quota: { remainingBytes: Math.max(0, quota.quotaBytes - quota.usedBytes) }
  });
}
