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

  /* Reassignment goes through the same gate as creation — a stale picker must not
     be able to hand an open lead to someone who has left. Clearing the owner
     (null/empty) stays valid. */
  if (body.assignedTo) {
    const assignee = await prisma.user.findUnique({
      where: { id: body.assignedTo },
      select: { status: true }
    });
    if (!assignee || assignee.status !== "ACTIVE") {
      return new Response("Cannot assign a lead to an inactive user", { status: 400 });
    }
  }

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
    /* The lead rightly keeps its historic owner, but the Deal is a brand-new record with
       live work attached — inheriting an owner who has left would create a pipeline entry
       nobody is chasing. Leaving it unassigned surfaces it as needing an owner. */
    const leadOwner = existing.assignedTo
      ? await prisma.user.findUnique({ where: { id: existing.assignedTo }, select: { status: true } })
      : null;
    const dealAssignedTo = leadOwner?.status === "ACTIVE" ? existing.assignedTo : null;

    const deal = await prisma.deal.create({
      data: {
        dealName: `${existing.company} — ${existing.name}`,
        stage: "NEEDS_ANALYSIS",
        amount: 0,
        assignedTo: dealAssignedTo,
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

