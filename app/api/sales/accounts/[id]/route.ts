import { NextRequest } from "next/server";
import { prisma } from "../../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../../lib/rbac-server";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) return new Response("Forbidden", { status: 403 });

  const { id } = await context.params;
  const body = await request.json();

  const data: Record<string, unknown> = {};
  if (body.companyName !== undefined) data.companyName = body.companyName;
  if (body.industry !== undefined) data.industry = body.industry || null;
  if (body.phone !== undefined) data.phone = body.phone || null;
  if (body.email !== undefined) data.email = body.email || null;
  if (body.website !== undefined) data.website = body.website || null;
  if (body.address !== undefined) data.address = body.address || null;
  if (body.notes !== undefined) data.notes = body.notes || null;

  const account = await prisma.account.update({
    where: { id },
    data,
    include: { _count: { select: { contacts: true, deals: true } } }
  });
  return Response.json(account);
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  await prisma.account.delete({ where: { id } });
  return Response.json({ ok: true });
}
