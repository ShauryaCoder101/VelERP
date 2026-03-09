import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";
import { createNotification } from "../../../lib/notifications";

export async function GET() {
  const calls = await prisma.bdCall.findMany({
    include: { addedByUser: { select: { id: true, name: true, designation: true } } },
    orderBy: { callDate: "desc" }
  });
  return Response.json(calls);
}

export async function POST(request: Request) {
  const { role, id: userId, name: userName } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const call = await prisma.bdCall.create({
    data: {
      company: body.company,
      pocName: body.pocName,
      pocPhone: body.pocPhone,
      pocEmail: body.pocEmail || null,
      callDate: new Date(body.callDate),
      remarks: body.remarks || null,
      status: body.status ?? "ACTIVE",
      addedBy: userId
    },
    include: { addedByUser: { select: { id: true, name: true, designation: true } } }
  });

  await createNotification(userId, "bd_call", "New BD Call", `${userName} logged a BD call with "${call.company}"`);
  return Response.json(call);
}
