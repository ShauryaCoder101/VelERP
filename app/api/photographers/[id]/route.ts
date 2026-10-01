import bcrypt from "bcryptjs";
import { prisma } from "../../../../lib/db";
import { getRequestUser } from "../../../../lib/rbac-server";
import { createNotification } from "../../../../lib/notifications";
import { MIN_PASSWORD_LENGTH, photographerSelect, serializePhotographer } from "../_shared";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: userId, name: userName } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const { id } = await context.params;
  const body = await request.json().catch(() => null);

  const status = body?.status === "ACTIVE" || body?.status === "INACTIVE" ? body.status : undefined;
  const password = typeof body?.password === "string" ? body.password : undefined;

  if (!status && password === undefined) {
    return Response.json({ error: "Nothing to change" }, { status: 400 });
  }
  if (password !== undefined && password.length < MIN_PASSWORD_LENGTH) {
    return Response.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, { status: 400 });
  }

  /* Loaded and role-checked before anything is written. This is the line between "any
     employee can create photographer accounts" and "any employee can edit any account" —
     without it, an intern could POST a new password onto the managing director's row. */
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, uid: true, role: true } });
  if (!target || target.role !== "PHOTOGRAPHER") {
    return Response.json({ error: "Photographer not found" }, { status: 404 });
  }

  const data: { status?: "ACTIVE" | "INACTIVE"; passwordHash?: string } = {};
  if (status) data.status = status;
  if (password !== undefined) data.passwordHash = await bcrypt.hash(password, 10);

  const now = new Date();
  let revokedLinks = 0;

  /* Deactivating an account is three writes that have to land together: flip the row
     to INACTIVE, kill the sessions the photographer is holding, and soft-revoke every
     open client link they minted. Run as separate statements, a failed link-revoke
     leaves the account deactivated while its links keep serving media — and the UI
     reports failure over links that are still live. One transaction makes deactivation
     all-or-nothing (mirrors the grant-removal DELETE in events/[eventId]/route.ts).

     Why each write is here — the session kill: deactivation and a password reset both
     have to reach the cookie the photographer already holds, not just the row, or an
     open upload tab keeps working. The link revoke: a share token carries its own
     signature and is checked against MediaShare.revokedAt alone, so a link outlives the
     login unless it is revoked here — every event, soft as always (revokedAt stamped,
     rows kept as the record). "Open" is /api/share GET's definition, so the count is the
     links that were genuinely still working. */
  const updated =
    status === "INACTIVE"
      ? await prisma.$transaction(async (tx) => {
          const u = await tx.user.update({ where: { id }, data, select: photographerSelect });
          await tx.session.deleteMany({ where: { userId: id } });
          const killed = await tx.mediaShare.updateMany({
            where: { createdBy: id, revokedAt: null, expiresAt: { gt: now } },
            data: { revokedAt: now }
          });
          revokedLinks = killed.count;
          return u;
        })
      : await (async () => {
          const u = await prisma.user.update({ where: { id }, data, select: photographerSelect });
          // A password reset (without deactivation) still has to end the open sessions.
          if (password !== undefined) await prisma.session.deleteMany({ where: { userId: id } });
          return u;
        })();

  if (status) {
    await createNotification(
      userId,
      "photographer_account",
      status === "ACTIVE" ? "Photographer reactivated" : "Photographer deactivated",
      `${userName} ${status === "ACTIVE" ? "reactivated" : "deactivated"} photographer account ${target.name} (${target.uid})` +
        (revokedLinks > 0
          ? `, withdrawing ${revokedLinks} client link${revokedLinks === 1 ? "" : "s"} they had created`
          : "")
    );
  }
  if (password !== undefined) {
    await createNotification(
      userId,
      "photographer_account",
      "Photographer password reset",
      `${userName} reset the password for photographer ${target.name} (${target.uid})`
    );
  }

  return Response.json({ photographer: serializePhotographer(updated), revokedLinks });
}
