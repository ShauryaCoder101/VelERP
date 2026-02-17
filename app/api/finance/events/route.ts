import { prisma } from "../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";

export async function GET(request: Request) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 2) && role !== "Accountant") {
    return new Response("Forbidden", { status: 403 });
  }

  const events = await prisma.event.findMany({
    where: { phase: "FINISHED" },
    include: {
      bills: { include: { vendor: true } },
      claims: { include: { user: true, items: true } }
    },
    orderBy: { toDate: "desc" }
  });

  return Response.json(events);
}
