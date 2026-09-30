import { prisma } from "../../../lib/db";
import { getRequestUser } from "../../../lib/rbac-server";

/* The feed is a running log of internal company activity — deals won, events closed,
   vendors onboarded. getRequestUser rather than getSessionUser, because third-party
   photographers hold real sessions and have no business reading any of it. */
export async function GET(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const notifications = await prisma.notification.findMany({
    include: { actor: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 30
  });
  return Response.json(notifications);
}

export async function PATCH(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const body = await request.json();

  if (body.markAllRead) {
    await prisma.notification.updateMany({ where: { read: false }, data: { read: true } });
  } else if (body.id) {
    await prisma.notification.update({ where: { id: body.id }, data: { read: true } });
  }

  return Response.json({ ok: true });
}
