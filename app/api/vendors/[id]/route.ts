import { prisma } from "../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";

export async function DELETE(request: Request, context: { params: { id: string } }) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 1)) {
    return new Response("Forbidden", { status: 403 });
  }

  await prisma.vendor.delete({ where: { id: context.params.id } });
  return new Response(null, { status: 204 });
}
