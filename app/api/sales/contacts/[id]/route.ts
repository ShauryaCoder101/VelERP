import { NextRequest } from "next/server";
import { prisma } from "../../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../../lib/rbac-server";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) return new Response("Forbidden", { status: 403 });

  const { id } = await context.params;
  const body = await request.json();

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.email !== undefined) data.email = body.email || null;
  if (body.phone !== undefined) data.phone = body.phone || null;
  if (body.company !== undefined) data.company = body.company || null;
  if (body.designation !== undefined) data.designation = body.designation || null;
  if (body.accountId !== undefined) data.accountId = body.accountId || null;
  if (body.notes !== undefined) data.notes = body.notes || null;

  const contact = await prisma.salesContact.update({
    where: { id },
    data,
    include: { account: { select: { id: true, companyName: true } } }
  });
  return Response.json(contact);
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  await prisma.salesContact.delete({ where: { id } });
  return Response.json({ ok: true });
}
