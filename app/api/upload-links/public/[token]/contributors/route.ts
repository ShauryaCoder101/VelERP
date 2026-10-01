import { prisma } from "../../../../../../lib/db";
import {
  MAX_CONTRIBUTOR_NAME,
  MAX_CONTRIBUTORS_PER_LINK,
  claimContributorFolder,
  contributorFolderName,
  generateSecret,
  hashSecret
} from "../../../../../../lib/upload-links";
import { openLink } from "../../../_public";

/* "What's your name?" — the only question an open link ever asks.
 *
 * It creates the person: a folder of their own inside the firm's folder, named
 * after them and stamped with the minute, and a secret their browser keeps so
 * the same device lands in the same folder next time. There is no password to
 * forget and no account to provision, which is the entire reason this exists.
 *
 * The name is a label, not a claim. Anyone with the link can type anything, so
 * this proves nothing about who they are — what it buys is that the firm's
 * thirty photographers stop being one anonymous pile. The authority is still the
 * link's, and the link's authority is still the firm's.
 *
 * The secret is returned exactly once and never again: only its sha256 is
 * stored, so a leak of the database does not hand out the ability to upload as
 * somebody else. Losing it means typing your name again and getting a new
 * folder — mildly annoying, and the only safe failure mode available. */

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  const resolved = await openLink(token);
  if (resolved instanceof Response) return resolved;
  const { link, firm } = resolved;

  const body = await request.json().catch(() => null);
  const name = (typeof body?.name === "string" ? body.name : "").trim().slice(0, MAX_CONTRIBUTOR_NAME);
  if (!name) return Response.json({ error: "Enter your name" }, { status: 400 });

  /* A bearer URL with no ceiling is a way to fill a table. The cap is per link
     rather than per firm so one busy shoot cannot starve the next one. */
  const existing = await prisma.uploadContributor.count({ where: { linkId: link.id } });
  if (existing >= MAX_CONTRIBUTORS_PER_LINK) {
    return Response.json(
      { error: "This link has been used by too many people. Ask the studio for a new one." },
      { status: 429 }
    );
  }

  /* The folder row comes FIRST and the name is whichever one its insert won.
     Two people typing "Ravi" in the same minute both produce the same candidate,
     and a check-then-insert would hand that one folder to both — identical
     upload roots, each able to write into what the other thinks is their own
     space. The unique index on (eventId, path) is the only thing that can
     actually arbitrate, so it does. */
  const { folderName, folderId } = await claimContributorFolder(
    link.eventId,
    firm.folder,
    contributorFolderName(name)
  );

  const secret = generateSecret();

  const contributor = await prisma.uploadContributor.create({
    data: { linkId: link.id, name, folderName, secretHash: hashSecret(secret) },
    select: { id: true, name: true, folderName: true }
  });

  /* Stamp the folder with its owner. Best effort: the folder exists and the
     person can upload either way, and contributorId only decides whether an
     empty folder shows up in their own breakdown. */
  if (folderId) {
    await prisma.mediaFolder
      .update({ where: { id: folderId }, data: { contributorId: contributor.id } })
      .catch(() => {});
  }

  return Response.json(
    {
      contributor: { id: contributor.id, name: contributor.name, folder: contributor.folderName },
      secret
    },
    { status: 201 }
  );
}
