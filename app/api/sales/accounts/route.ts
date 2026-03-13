import { prisma } from "../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";

export async function GET() {
  const accounts = await prisma.account.findMany({
    include: {
      _count: { select: { contacts: true, deals: true } }
    },
    orderBy: { createdAt: "desc" }
  });
  return Response.json(accounts);
}

export async function POST(request: Request) {
  const { role, id: userId } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) return new Response("Forbidden", { status: 403 });

  const body = await request.json();
  const account = await prisma.account.create({
    data: {
      companyName: body.companyName,
      industry: body.industry || null,
      phone: body.phone || null,
      email: body.email || null,
      website: body.website || null,
      address: body.address || null,
      notes: body.notes || null,
      createdBy: userId
    },
    include: { _count: { select: { contacts: true, deals: true } } }
  });
  return Response.json(account);
}
