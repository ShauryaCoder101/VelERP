import { prisma } from "../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";

export async function GET() {
  const contacts = await prisma.salesContact.findMany({
    include: { account: { select: { id: true, companyName: true } } },
    orderBy: { createdAt: "desc" }
  });
  return Response.json(contacts);
}

export async function POST(request: Request) {
  const { role, id: userId } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) return new Response("Forbidden", { status: 403 });

  const body = await request.json();
  const contact = await prisma.salesContact.create({
    data: {
      name: body.name,
      email: body.email || null,
      phone: body.phone || null,
      company: body.company || null,
      designation: body.designation || null,
      accountId: body.accountId || null,
      notes: body.notes || null,
      createdBy: userId
    },
    include: { account: { select: { id: true, companyName: true } } }
  });
  return Response.json(contact);
}
