import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "../../../../../lib/db";
import { normalizeRole } from "../../../../../lib/rbac";
import { getRequestUser, requireMinLevel } from "../../../../../lib/rbac-server";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role, id: currentUserId } = await getRequestUser(request);
  if (!requireMinLevel(role, 1)) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id } = await context.params;
  const body = await request.json();
  const data: Record<string, unknown> = {};

  if (body.newPassword) {
    data.passwordHash = await bcrypt.hash(body.newPassword, 10);
  }
  if (body.role) data.role = body.role;
  if (body.designation) data.designation = body.designation;
  if (body.status) data.status = body.status;
  if (body.name) data.name = body.name;
  if (body.email) data.email = body.email;
  if (body.team !== undefined) data.team = body.team || null;

  /* Going inactive kills your sessions and login refuses inactive users, so doing it to
     yourself is a one-way lockout that only another level-1 admin could undo. */
  if (data.status === "INACTIVE" && id === currentUserId) {
    return Response.json({ error: "Cannot deactivate your own account" }, { status: 400 });
  }

  /* Same one-way lockout by another route: demoting yourself out of level 1 takes away the
     admin panel you would need to undo it. */
  if (data.role && id === currentUserId && !requireMinLevel(normalizeRole(String(data.role)), 1)) {
    return Response.json({ error: "Cannot change your own role" }, { status: 400 });
  }

  // Explicit select: the default payload includes passwordHash, which has no business
  // leaving the server.
  const user = await prisma.user.update({
    where: { id },
    data,
    select: {
      id: true,
      uid: true,
      name: true,
      email: true,
      designation: true,
      role: true,
      team: true,
      avatarUrl: true,
      status: true,
      createdAt: true
    }
  });

  // Deactivation has to reach the cookie the user is already holding, not just the label.
  if (data.status === "INACTIVE") {
    await prisma.session.deleteMany({ where: { userId: id } });
  }

  return Response.json(user);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role, id: currentUserId } = await getRequestUser(request);
  if (!requireMinLevel(role, 1)) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id } = await context.params;
  if (id === currentUserId) {
    return Response.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  await prisma.session.deleteMany({ where: { userId: id } });
  await prisma.user.delete({ where: { id } });
  return Response.json({ ok: true });
}
