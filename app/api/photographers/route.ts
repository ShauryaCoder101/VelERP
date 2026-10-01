import bcrypt from "bcryptjs";
import { prisma } from "../../../lib/db";
import { getRequestUser } from "../../../lib/rbac-server";
import { createNotification } from "../../../lib/notifications";
import { ensureProfile } from "../../../lib/photographers";
import { firmFolderName } from "../../../lib/upload-links";
import {
  EMAIL_PATTERN,
  MIN_PASSWORD_LENGTH,
  photographerSelect,
  serializePhotographer,
  type PhotographerRow
} from "./_shared";

/* The photographer panel is deliberately open to EVERY employee: whoever is running a
   shoot needs to hand the photographer credentials on the day, and routing that through a
   level-1 admin would mean it happens over WhatsApp instead. Two guardrails make that
   safe — these endpoints only ever touch role PHOTOGRAPHER rows, and every mutation writes
   a company-wide notification naming who did it.
   Photographers themselves are shut out automatically: getRequestUser returns the
   anonymous shape for a photographer session, so the !userId check catches them. */

export async function GET(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const includeInactive = new URL(request.url).searchParams.get("includeInactive") === "1";

  const rows = await prisma.user.findMany({
    where: {
      role: "PHOTOGRAPHER",
      ...(includeInactive ? {} : { status: "ACTIVE" as const })
    },
    select: photographerSelect,
    orderBy: { createdAt: "desc" }
  });

  const reach = await linkReach(rows.map((row) => row.id));

  return Response.json({
    photographers: rows.map((row) => ({
      ...serializePhotographer(row),
      ...(reach.get(row.id) ?? { openUploadLinks: 0, contributors: 0 })
    }))
  });
}

/* How far each firm's links have spread: live links, and people who have used
   any of them. Two grouped queries for the whole page rather than two per firm.

   Fault-tolerant on purpose. The photographer panel is a core staff screen and
   migrations on this project are applied by hand, after the code ships — a
   deploy that lands ahead of the migration must cost these two numbers, not the
   list itself. */
const linkReach = async (photographerIds: string[]) => {
  const reach = new Map<string, { openUploadLinks: number; contributors: number }>();
  if (photographerIds.length === 0) return reach;

  try {
    const links = await prisma.uploadLink.findMany({
      where: { photographerId: { in: photographerIds } },
      select: { id: true, photographerId: true, revokedAt: true, expiresAt: true }
    });
    if (links.length === 0) return reach;

    const crowds = await prisma.uploadContributor.groupBy({
      by: ["linkId"],
      where: { linkId: { in: links.map((link) => link.id) } },
      _count: true
    });
    const perLink = new Map(crowds.map((row) => [row.linkId, row._count]));

    const now = Date.now();
    for (const link of links) {
      const at = reach.get(link.photographerId) ?? { openUploadLinks: 0, contributors: 0 };
      // "Open" is live right now: not closed by staff and not yet expired.
      if (!link.revokedAt && link.expiresAt.getTime() > now) at.openUploadLinks += 1;
      // Contributors count across ALL of the firm's links, closed ones included:
      // the people are still in the folders whatever happened to the URL.
      at.contributors += perLink.get(link.id) ?? 0;
      reach.set(link.photographerId, at);
    }
  } catch {
    return reach;
  }

  return reach;
};

/* uid is "TPP-004", numbered after the highest that exists rather than after the row count,
   so a deleted account can never cause a collision. Two employees creating at the same
   moment still can, hence the retry in POST. */
const nextTppUid = async () => {
  const existing = await prisma.user.findMany({
    where: { uid: { startsWith: "TPP-" } },
    select: { uid: true }
  });
  const highest = existing.reduce((max, { uid }) => {
    const n = Number.parseInt(uid.slice(4), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `TPP-${String(highest + 1).padStart(3, "0")}`;
};

export async function POST(request: Request) {
  const { id: userId, name: userName } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!name) return Response.json({ error: "Name is required" }, { status: 400 });
  if (!EMAIL_PATTERN.test(email)) return Response.json({ error: "Enter a valid email address" }, { status: 400 });
  if (password.length < MIN_PASSWORD_LENGTH) {
    return Response.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, { status: 400 });
  }

  /* Checked against ALL users, not just photographers: email is globally unique, so an
     employee's address would otherwise fail at the database with an opaque error. */
  const clash = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (clash) {
    return Response.json({ error: "An account with this email already exists" }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  let created: PhotographerRow | null = null;
  for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
    try {
      created = await prisma.user.create({
        data: {
          uid: await nextTppUid(),
          name,
          email,
          passwordHash,
          designation: "Third-party photographer",
          role: "PHOTOGRAPHER",
          status: "ACTIVE"
        },
        select: photographerSelect
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const target = String((error as { meta?: { target?: unknown } }).meta?.target ?? "");
      // Two employees adding a photographer at once race on the uid; the email clash was
      // already ruled out above, so re-reading the highest number and retrying is the fix.
      if (code === "P2002" && target.includes("uid")) continue;
      if (code === "P2002") {
        return Response.json({ error: "An account with this email already exists" }, { status: 409 });
      }
      throw error;
    }
  }

  if (!created) {
    return Response.json({ error: "Could not allocate a photographer ID. Please try again." }, { status: 409 });
  }

  await ensureProfile(created.id, userId);

  /* Settle the firm's folder now rather than on first upload. It is UNIQUE, so
     two firms with the same name have to be told apart — and doing that here
     means the clash is resolved once, at a moment nothing depends on, instead
     of in the middle of a thousand-file upload. */
  await firmFolderName(created.id);

  await createNotification(
    userId,
    "photographer_account",
    "Photographer account created",
    `${userName} created photographer account ${created.name} (${created.uid})`
  );

  // Re-read so the response carries the profile row ensureProfile just wrote.
  const withProfile = await prisma.user.findUnique({ where: { id: created.id }, select: photographerSelect });
  return Response.json({ photographer: serializePhotographer(withProfile ?? created) }, { status: 201 });
}
