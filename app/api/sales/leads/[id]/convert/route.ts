import { NextRequest } from "next/server";
import { prisma } from "../../../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../../../lib/rbac-server";
import { createNotification } from "../../../../../../lib/notifications";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role, id: userId, name: userName } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) return new Response("Forbidden", { status: 403 });

  const { id } = await context.params;
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) return new Response("Lead not found", { status: 404 });
  if (lead.convertedDealId) return Response.json({ error: "Already converted" }, { status: 400 });

  const deal = await prisma.deal.create({
    data: {
      dealName: `${lead.company} — ${lead.name}`,
      stage: "QUALIFICATION",
      amount: 0,
      assignedTo: lead.assignedTo,
      notes: lead.notes,
      createdBy: userId
    },
    include: {
      account: { select: { id: true, companyName: true } },
      assignedToUser: { select: { id: true, name: true } }
    }
  });

  await prisma.lead.update({
    where: { id },
    data: { status: "QUALIFIED", convertedDealId: deal.id }
  });

  await createNotification(userId, "lead_converted", "Lead Converted to Deal", `${userName} converted lead "${lead.name}" to a deal`);

  return Response.json(deal);
}
