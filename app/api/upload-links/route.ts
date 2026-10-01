import { prisma } from "../../../lib/db";
import { getUploader } from "../../../lib/rbac-server";
import { hasEventAccess } from "../../../lib/photographers";
import {
  DEFAULT_LINK_DAYS,
  LINK_DAY_CHOICES,
  firmFolderName,
  generateToken
} from "../../../lib/upload-links";
import { LINK_SELECT, linkSummaries, type LinkRow } from "../../../lib/upload-link-stats";

/* A firm's open upload links: the ones it has minted, and the mint.
 *
 * Only the firm's main login comes through here. Staff read the same data from
 * /api/photographers/[id]/activity, which spans every firm; this endpoint is
 * deliberately "mine", with no parameter that could widen it.
 *
 * A link is not a new principal — it inherits the firm's event grant, the
 * firm's 1 TB and the firm's folder. So the only authority needed to mint one is
 * the authority the firm already has over that event, and there is nothing a
 * link can reach that its firm could not. What creating one DOES hand out is a
 * password-less URL, which is why it expires, why staff can close it and the
 * firm cannot, and why every byte through it is tracked by name. */

const DAY_MS = 24 * 60 * 60 * 1000;

/* Links are cheap to mint and each one admits a thousand contributors, so an
   unbounded list is both a tracker nobody can read and a lever. Only live links
   count: closing or outliving them frees the slot. */
const MAX_OPEN_LINKS_PER_FIRM = 200;

/** The list is a page the firm reads, not a feed. */
const LIST_LIMIT = 500;

const forbidden = () => new Response("Forbidden", { status: 403 });

type Firm = { id: string; folder: string };

/* The firm's main login, with its folder settled. Contributors are refused:
   getUploader reads the session cookie only, so an open link's headers mean
   nothing here — a link may upload, it may not mint more links. */
const firmCaller = async (request: Request): Promise<Firm | Response> => {
  const uploader = await getUploader(request);
  if (!uploader) return forbidden();
  if (!uploader.isPhotographer) {
    return Response.json({ error: "This is for photographer accounts" }, { status: 403 });
  }
  if (uploader.status !== "ACTIVE") return forbidden();

  const folder = await firmFolderName(uploader.id);
  if (folder === null) return forbidden();
  return { id: uploader.id, folder };
};

export async function GET(request: Request) {
  const firm = await firmCaller(request);
  if (firm instanceof Response) return firm;

  const links = await prisma.uploadLink.findMany({
    where: { photographerId: firm.id },
    select: LINK_SELECT,
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT
  });

  // Closed links stay in the list, with their status — "where did that link go"
  // is a question the tracker should answer rather than swallow.
  return Response.json({ links: await linkSummaries(links, firm.folder) });
}

export async function POST(request: Request) {
  const firm = await firmCaller(request);
  if (firm instanceof Response) return firm;

  const body = await request.json().catch(() => null);
  const eventId = typeof body?.eventId === "string" ? body.eventId : "";
  if (!eventId) return Response.json({ error: "Select an event" }, { status: 400 });

  /* The grant is the authority. Re-checked here rather than trusted from the
     event list the firm was shown, which may be minutes old. */
  if (!(await hasEventAccess(firm.id, eventId))) {
    return Response.json({ error: "You don't have access to this event" }, { status: 403 });
  }

  const rawLabel = typeof body?.label === "string" ? body.label.trim() : "";
  const label = rawLabel ? rawLabel.slice(0, 80) : null;

  const requested = Number(body?.days);
  const days = (LINK_DAY_CHOICES as readonly number[]).includes(requested) ? requested : DEFAULT_LINK_DAYS;

  const now = Date.now();
  const live = await prisma.uploadLink.count({
    where: { photographerId: firm.id, revokedAt: null, expiresAt: { gt: new Date(now) } }
  });
  if (live >= MAX_OPEN_LINKS_PER_FIRM) {
    return Response.json(
      { error: "You already have the maximum number of open links. Ask Velocity to close some." },
      { status: 429 }
    );
  }

  /* 192 bits of randomness, so a collision is not a thing that happens — but a
     retry costs one statement and a unique-constraint 500 costs a shoot. */
  let created: LinkRow | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    try {
      created = await prisma.uploadLink.create({
        data: {
          token: generateToken(),
          photographerId: firm.id,
          eventId,
          label,
          expiresAt: new Date(now + days * DAY_MS)
        },
        select: LINK_SELECT
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
    }
  }
  if (!created) {
    return Response.json({ error: "Couldn't create the link. Please try again." }, { status: 500 });
  }

  const [link] = await linkSummaries([created], firm.folder);
  return Response.json({ link }, { status: 201 });
}
