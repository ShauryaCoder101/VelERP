import { NextRequest } from "next/server";
import { prisma } from "../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 1)) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id } = await context.params;
  await prisma.vendor.delete({ where: { id } });
  return new Response(null, { status: 204 });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role, id: userId } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id } = await context.params;

  // Check vendor exists
  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) return new Response("Not found", { status: 404 });

  // Ownership check: only onboarder or MD can edit
  const isMD = requireMinLevel(role, 1);
  if (!isMD && vendor.onboardedBy !== userId) {
    return new Response("You can only edit vendors you onboarded", { status: 403 });
  }

  const body = await request.json();
  const updateData: Record<string, unknown> = {};

  if (body.companyName !== undefined) updateData.companyName = body.companyName;
  if (body.email !== undefined) updateData.email = body.email || null;
  if (body.phone !== undefined) updateData.phone = body.phone;
  if (body.work !== undefined) updateData.work = body.work;
  if (body.location !== undefined) updateData.location = body.location || null;
  if (body.gstin !== undefined) updateData.gstin = body.gstin || null;
  if (body.panCard !== undefined) updateData.panCard = body.panCard || null;
  if (body.pocName !== undefined) updateData.pocName = body.pocName || null;
  if (body.status !== undefined) updateData.status = body.status;
  if (body.currentEvent !== undefined) updateData.currentEvent = body.currentEvent || null;

  const updated = await prisma.vendor.update({
    where: { id },
    data: updateData,
    include: { onboardedByUser: { select: { id: true, name: true } } }
  });

  return Response.json(updated);
}
