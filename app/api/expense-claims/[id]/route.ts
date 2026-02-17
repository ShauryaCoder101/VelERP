import { prisma } from "../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";

export async function PATCH(request: Request, context: { params: { id: string } }) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 2) && role !== "Accountant") {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const claim = await prisma.expenseClaim.update({
    where: { id: context.params.id },
    data: {
      status: body.status
    }
  });

  return Response.json(claim);
}
