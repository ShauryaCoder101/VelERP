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

  const updated = await prisma.user.update({ where: { id }, data, select: photographerSelect });

  /* Deactivation and a password reset both have to reach the cookie the photographer is
     already holding, not just the row — otherwise an open upload tab keeps working. */
  if (status === "INACTIVE" || password !== undefined) {
    await prisma.session.deleteMany({ where: { userId: id } });
  }

  if (status) {
    await createNotification(
      userId,
      "photographer_account",
      status === "ACTIVE" ? "Photographer reactivated" : "Photographer deactivated",
      `${userName} ${status === "ACTIVE" ? "reactivated" : "deactivated"} photographer account ${target.name} (${target.uid})`
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

  return Response.json({ photographer: serializePhotographer(updated) });
}
