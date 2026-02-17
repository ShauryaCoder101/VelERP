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
