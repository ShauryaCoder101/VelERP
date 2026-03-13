import { NextRequest } from "next/server";
import { prisma } from "../../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../../lib/rbac-server";
import { createNotification } from "../../../../../lib/notifications";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const deal = await prisma.deal.findUnique({
    where: { id },
    include: {
      account: { select: { id: true, companyName: true } },
      assignedToUser: { select: { id: true, name: true } }
    }
  });
  if (!deal) return new Response("Not found", { status: 404 });
  return Response.json(deal);
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role, id: userId, name: userName } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) return new Response("Forbidden", { status: 403 });

  const { id } = await context.params;
  const body = await request.json();

  const data: Record<string, unknown> = {};
  if (body.dealName !== undefined) data.dealName = body.dealName;
  if (body.accountId !== undefined) data.accountId = body.accountId || null;
  if (body.stage !== undefined) data.stage = body.stage;
  if (body.amount !== undefined) data.amount = parseFloat(body.amount);
  if (body.expectedCloseDate !== undefined) data.expectedCloseDate = body.expectedCloseDate ? new Date(body.expectedCloseDate) : null;
  if (body.notes !== undefined) data.notes = body.notes || null;
  if (body.assignedTo !== undefined) data.assignedTo = body.assignedTo || null;

  const deal = await prisma.deal.update({
    where: { id },
    data,
    include: {
      account: { select: { id: true, companyName: true } },
      assignedToUser: { select: { id: true, name: true } }
    }
  });

  if (body.stage === "CLOSED_WON") {
    await createNotification(userId, "deal_won", "Deal Won!", `${userName} closed deal "${deal.dealName}" worth ₹${deal.amount.toLocaleString("en-IN")}`);
  }

  return Response.json(deal);
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  await prisma.deal.delete({ where: { id } });
  return Response.json({ ok: true });
}
