import { prisma } from "../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";
import { createNotification } from "../../../../lib/notifications";

export async function GET() {
  const deals = await prisma.deal.findMany({
    include: {
      account: { select: { id: true, companyName: true } },
      assignedToUser: { select: { id: true, name: true } }
    },
    orderBy: { createdAt: "desc" }
  });
  return Response.json(deals);
}

export async function POST(request: Request) {
  const { role, id: userId, name: userName } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) return new Response("Forbidden", { status: 403 });

  const body = await request.json();

  /* The picker already hides people who have left, but the client can be stale or
     bypassed entirely — this is the gate that actually decides. Ownership is
     optional here, so only a supplied id is checked. */
  if (body.assignedTo) {
    const assignee = await prisma.user.findUnique({
      where: { id: body.assignedTo },
      select: { status: true }
    });
    if (!assignee || assignee.status !== "ACTIVE") {
      return new Response("Cannot assign a deal to an inactive user", { status: 400 });
    }
  }

  const deal = await prisma.deal.create({
    data: {
      dealName: body.dealName,
      accountId: body.accountId || null,
      stage: body.stage ?? "QUALIFICATION",
      amount: body.amount ? parseFloat(body.amount) : 0,
      expectedCloseDate: body.expectedCloseDate ? new Date(body.expectedCloseDate) : null,
      notes: body.notes || null,
      assignedTo: body.assignedTo || null,
      createdBy: userId
    },
    include: {
      account: { select: { id: true, companyName: true } },
      assignedToUser: { select: { id: true, name: true } }
    }
  });

  await createNotification(userId, "deal", "New Deal Created", `${userName} created deal "${deal.dealName}" worth ₹${deal.amount.toLocaleString("en-IN")}`);
  return Response.json(deal);
}
