import { prisma } from "../../../../lib/db";
import { getRequestUser } from "../../../../lib/rbac-server";

export async function GET(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const deals = await prisma.deal.findMany({
    where: {
      expectedCloseDate: { not: null, gte: new Date() },
      stage: { notIn: ["CLOSED_WON", "CLOSED_LOST"] }
    },
    select: {
      id: true,
      dealName: true,
      amount: true,
      stage: true,
      expectedCloseDate: true,
      assignedToUser: { select: { name: true } }
    },
    orderBy: { expectedCloseDate: "asc" },
    take: 10
  });
  return Response.json(deals);
}
