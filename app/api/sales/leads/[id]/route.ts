import { NextRequest } from "next/server";
import { prisma } from "../../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../../lib/rbac-server";
import { createNotification } from "../../../../../lib/notifications";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: { assignedToUser: { select: { id: true, name: true } } }
  });
  if (!lead) return new Response("Not found", { status: 404 });
  return Response.json(lead);
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role, id: userId, name: userName } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) return new Response("Forbidden", { status: 403 });

  const { id } = await context.params;
  const body = await request.json();

  const existing = await prisma.lead.findUnique({ where: { id } });
  if (!existing) return new Response("Not found", { status: 404 });

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.company !== undefined) data.company = body.company;
  if (body.email !== undefined) data.email = body.email || null;
  if (body.phone !== undefined) data.phone = body.phone || null;
  if (body.address !== undefined) data.address = body.address || null;
  if (body.source !== undefined) data.source = body.source;
  if (body.status !== undefined) data.status = body.status;
  if (body.notes !== undefined) data.notes = body.notes || null;
  if (body.assignedTo !== undefined) data.assignedTo = body.assignedTo || null;

  const shouldConvert = !existing.convertedDealId
    && body.status
    && (body.status === "CONTACTED" || body.status === "QUALIFIED")
    && existing.status === "NEW";

  if (shouldConvert) {
    const deal = await prisma.deal.create({
      data: {
        dealName: `${existing.company} — ${existing.name}`,
        stage: "NEEDS_ANALYSIS",
        amount: 0,
        assignedTo: existing.assignedTo,
        notes: existing.notes,
        createdBy: userId
      }
    });
    data.convertedDealId = deal.id;
    await createNotification(userId, "lead_converted", "Lead Converted to Deal", `${userName} converted lead "${existing.name}" to a deal`);
  }

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

