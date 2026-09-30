import { prisma } from "../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";
import { createNotification } from "../../../../lib/notifications";

export async function GET(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

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

  /* The picker already hides people who have left, but the client can be stale or
     bypassed entirely — this is the gate that actually decides. Ownership is
     optional here, so only a supplied id is checked. */
  if (body.assignedTo) {
    const assignee = await prisma.user.findUnique({
      where: { id: body.assignedTo },
      select: { status: true, role: true }
    });
    if (!assignee || assignee.status !== "ACTIVE") {
      return new Response("Cannot assign a lead to an inactive user", { status: 400 });
    }
    /* Photographers are third-party contractors with upload-only access — they can never
       own a pipeline record. */
    if (assignee.role === "PHOTOGRAPHER") {
      return new Response("Cannot assign a lead to a photographer", { status: 400 });
    }
  }

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
