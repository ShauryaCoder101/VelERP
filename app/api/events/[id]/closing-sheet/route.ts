import { NextRequest } from "next/server";
import { prisma } from "../../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../../lib/rbac-server";
import { createNotification } from "../../../../../lib/notifications";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role, id: userId, name: userName } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id } = await context.params;
  const body = await request.json();

  const event = await prisma.event.update({
    where: { id },
    data: {
      closingSheetUrl: body.closingSheetUrl,
      phase: "FINISHED"
    }
  });

  await createNotification(userId, "event_closed", "Event Closed", `${userName} closed event "${event.eventName}" for ${event.companyName}`);
  return Response.json(event);
}
