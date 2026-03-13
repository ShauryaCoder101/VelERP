import { prisma } from "../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";
import { createNotification } from "../../../../lib/notifications";

export async function GET() {
  const leads = await prisma.lead.findMany({
    include: { assignedToUser: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" }
  });
  return Response.json(leads);
}

export async function POST(request: Request) {
  const { role, id: userId, name: userName } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) return new Response("Forbidden", { status: 403 });

  const body = await request.json();
  const lead = await prisma.lead.create({
    data: {
      name: body.name,
      company: body.company,
      email: body.email || null,
      phone: body.phone || null,
      source: body.source ?? "OTHER",
      status: body.status ?? "NEW",
      notes: body.notes || null,
      assignedTo: body.assignedTo || null,
      createdBy: userId
    },
    include: { assignedToUser: { select: { id: true, name: true } } }
  });

  await createNotification(userId, "lead", "New Lead Added", `${userName} added lead "${lead.name}" from ${lead.company}`);
  return Response.json(lead);
}
