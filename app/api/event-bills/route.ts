import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";

export async function GET(request: Request) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 2) && role !== "Accountant") {
    return new Response("Forbidden", { status: 403 });
  }

  const bills = await prisma.eventBill.findMany({
    include: { event: true, vendor: true },
    orderBy: { date: "desc" }
  });
  return Response.json(bills);
}

export async function POST(request: Request) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 2) && role !== "Accountant") {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const bill = await prisma.eventBill.create({
    data: {
      eventId: body.eventId,
      vendorId: body.vendorId,
      vendorGstin: body.vendorGstin ?? null,
      date: new Date(body.date),
      work: body.work,
      amountPaid: Number(body.amountPaid)
    }
  });
  return Response.json(bill);
}
