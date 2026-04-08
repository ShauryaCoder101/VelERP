import { NextRequest } from "next/server";
import { prisma } from "../../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../../lib/rbac-server";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: eventId } = await context.params;

  const finances = await prisma.eventVendorFinance.findMany({
    where: { eventId },
    include: { vendor: { select: { id: true, companyName: true, work: true } } },
    orderBy: { createdAt: "asc" }
  });

  return Response.json(finances);
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role, id: userId } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id: eventId } = await context.params;

  // Check user is a team member of this event
  const isMD = requireMinLevel(role, 1);
  if (!isMD) {
    const membership = await prisma.eventTeamMember.findUnique({
      where: { eventId_userId: { eventId, userId } }
    });
    if (!membership) {
      return new Response("Only event team members can manage finances", { status: 403 });
    }
  }

  const body = await request.json();
  const { vendorId, quotedAmount, advancePaid, totalPaid, closed, notes } = body;

  if (!vendorId) {
    return new Response("vendorId is required", { status: 400 });
  }

  // Upsert finance record
  const finance = await prisma.eventVendorFinance.upsert({
    where: { eventId_vendorId: { eventId, vendorId } },
    create: {
      eventId,
      vendorId,
      quotedAmount: quotedAmount ?? 0,
      advancePaid: advancePaid ?? 0,
      totalPaid: totalPaid ?? 0,
      closed: closed ?? false,
      notes: notes ?? null
    },
    update: {
      ...(quotedAmount !== undefined && { quotedAmount }),
      ...(advancePaid !== undefined && { advancePaid }),
      ...(totalPaid !== undefined && { totalPaid }),
      ...(closed !== undefined && { closed }),
      ...(notes !== undefined && { notes: notes || null })
    },
    include: { vendor: { select: { id: true, companyName: true, work: true } } }
  });

  return Response.json(finance);
}
