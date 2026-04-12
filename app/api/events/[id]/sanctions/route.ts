import { NextRequest } from "next/server";
import { prisma } from "../../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../../lib/rbac-server";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: eventId } = await context.params;

  const sanctions = await prisma.eventSanction.findMany({
    where: { eventId },
    include: { user: { select: { id: true, name: true, designation: true } } },
    orderBy: { createdAt: "asc" }
  });

  return Response.json(sanctions);
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role } = await getRequestUser(request);
  // Only MD-level or Accountant can manage sanctions
  const isMD = requireMinLevel(role, 1);
  const isAccountant = role === "Accountant";
  if (!isMD && !isAccountant) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id: eventId } = await context.params;
  const body = await request.json();
  const { userId, sanctionedAmount, notes } = body;

  if (!userId) {
    return new Response("userId is required", { status: 400 });
  }

  // Upsert sanction record
  const sanction = await prisma.eventSanction.upsert({
    where: { eventId_userId: { eventId, userId } },
    create: {
      eventId,
      userId,
      sanctionedAmount: sanctionedAmount ?? 0,
      notes: notes ?? null
    },
    update: {
      ...(sanctionedAmount !== undefined && { sanctionedAmount }),
      ...(notes !== undefined && { notes: notes || null })
    },
    include: { user: { select: { id: true, name: true, designation: true } } }
  });

  return Response.json(sanction);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role } = await getRequestUser(request);
  const isMD = requireMinLevel(role, 1);
  const isAccountant = role === "Accountant";
  if (!isMD && !isAccountant) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id: eventId } = await context.params;
  const body = await request.json();
  const { userId } = body;

  if (!userId) {
    return new Response("userId is required", { status: 400 });
  }

  await prisma.eventSanction.deleteMany({
    where: { eventId, userId }
  });

  return Response.json({ ok: true });
}
