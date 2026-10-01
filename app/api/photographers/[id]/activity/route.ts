import { prisma } from "../../../../../lib/db";
import { getRequestUser } from "../../../../../lib/rbac-server";
import { PHOTOGRAPHER_QUOTA_BYTES } from "../../../../../lib/photographers";
import { firmFolderName } from "../../../../../lib/upload-links";
import { LINK_SELECT, linkDetails, mainAccountStats } from "../../../../../lib/upload-link-stats";

/* Everything one firm has done, for staff: its links, the people behind them,
 * the folders and loose files each of them produced, and what the main login
 * uploaded itself.
 *
 * Employees only, and every employee — the same rule as the rest of the
 * photographer panel, and for the same reason: whoever is running the shoot is
 * the person who needs to see whether the footage actually arrived, and routing
 * that through an admin means it happens over WhatsApp instead. Photographers
 * are shut out automatically, because getRequestUser returns the anonymous shape
 * for a photographer session. A firm reads its own figures from
 * /api/upload-links, which is the same aggregation scoped to itself.
 *
 * Read-only. */

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const { id } = await context.params;

  /* PHOTOGRAPHER-only, like every other endpoint in this panel: an employee id
     here would report an employee's uploads under a "firm" heading. */
  const photographer = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      uid: true,
      name: true,
      status: true,
      role: true,
      photographerProfile: { select: { quotaBytes: true, allocatedBytes: true } }
    }
  });
  if (!photographer || photographer.role !== "PHOTOGRAPHER") {
    return Response.json({ error: "Photographer not found" }, { status: 404 });
  }

  // Settles the folder name if this firm predates the feature and has never
  // uploaded since; everything below is measured against it.
  const folder = await firmFolderName(photographer.id);
  if (folder === null) return Response.json({ error: "Photographer not found" }, { status: 404 });

  const links = await prisma.uploadLink.findMany({
    where: { photographerId: photographer.id },
    select: LINK_SELECT,
    orderBy: { createdAt: "desc" }
  });

  const [details, mainAccount] = await Promise.all([
    linkDetails(links, folder),
    mainAccountStats(photographer.id, folder)
  ]);

  return Response.json({
    photographer: {
      id: photographer.id,
      uid: photographer.uid,
      name: photographer.name,
      folder,
      status: photographer.status
    },
    /* BigInt cannot be serialised by Response.json — it throws rather than
       degrading — so the conversion happens at this boundary. Byte counts stay
       far below Number.MAX_SAFE_INTEGER. */
    quota: {
      quotaBytes: Number(photographer.photographerProfile?.quotaBytes ?? BigInt(PHOTOGRAPHER_QUOTA_BYTES)),
      allocatedBytes: Number(photographer.photographerProfile?.allocatedBytes ?? 0n)
    },
    links: details,
    mainAccount
  });
}
