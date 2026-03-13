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
  if (body.company !== undefined) data.company = body.company;
  if (body.email !== undefined) data.email = body.email || null;
  if (body.phone !== undefined) data.phone = body.phone || null;
  if (body.source !== undefined) data.source = body.source;
  if (body.status !== undefined) data.status = body.status;
  if (body.notes !== undefined) data.notes = body.notes || null;
  if (body.assignedTo !== undefined) data.assignedTo = body.assignedTo || null;

  const lead = await prisma.lead.update({
    where: { id },
    data,
    include: { assignedToUser: { select: { id: true, name: true } } }
  });
  return Response.json(lead);
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  await prisma.lead.delete({ where: { id } });
  return Response.json({ ok: true });
}
