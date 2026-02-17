import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";

export async function GET(request: Request) {
  const { id: userId, role } = await getRequestUser(request);
  const isManager = requireMinLevel(role, 2) || role === "Accountant";
  const claims = await prisma.expenseClaim.findMany({
    where: isManager ? undefined : { userId },
    include: { items: true, attachments: true, event: true, user: true },
    orderBy: { submittedAt: "desc" }
  });
  return Response.json(claims);
}

export async function POST(request: Request) {
  const { role, id: userId } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const claim = await prisma.expenseClaim.create({
    data: {
      userId,
      eventId: body.eventId ?? null,
      status: body.status ?? "INCOMPLETE",
      items: body.items
        ? {
            create: body.items.map((item: { eventName: string; location: string; type: string; date: string; amount: number }) => ({
              eventName: item.eventName,
              location: item.location,
              type: item.type,
              date: new Date(item.date),
              amount: Number(item.amount)
            }))
          }
        : undefined,
      attachments: body.attachments
        ? {
            create: body.attachments.map((file: { fileUrl: string; fileType: string }) => ({
              fileUrl: file.fileUrl,
              fileType: file.fileType
            }))
          }
        : undefined
    }
  });

  return Response.json(claim);
}
