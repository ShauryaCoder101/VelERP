import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "../../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../../lib/rbac-server";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role } = await getRequestUser(request);
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

  const user = await prisma.user.update({ where: { id }, data });
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
