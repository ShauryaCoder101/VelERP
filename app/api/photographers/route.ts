import bcrypt from "bcryptjs";
import { prisma } from "../../../lib/db";
import { getRequestUser } from "../../../lib/rbac-server";
import { createNotification } from "../../../lib/notifications";
import { ensureProfile } from "../../../lib/photographers";
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

  return Response.json({ photographers: rows.map(serializePhotographer) });
}

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
