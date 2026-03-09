import { NextRequest } from "next/server";
import { prisma } from "../../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../../lib/rbac-server";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id } = await context.params;
  const body = await request.json();

  const event = await prisma.event.update({
    where: { id },
    data: { costSheetUrl: body.costSheetUrl }
  });

  return Response.json(event);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id } = await context.params;
  const event = await prisma.event.update({
    where: { id },
    data: { costSheetUrl: null }
  });

  return Response.json(event);
}
