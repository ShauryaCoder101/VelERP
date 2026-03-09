import { prisma } from "../../../lib/db";
import { getSessionUser } from "../../../lib/session";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const notifications = await prisma.notification.findMany({
    include: { actor: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 30
  });
  return Response.json(notifications);
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const body = await request.json();

  if (body.markAllRead) {
    await prisma.notification.updateMany({ where: { read: false }, data: { read: true } });
  } else if (body.id) {
    await prisma.notification.update({ where: { id: body.id }, data: { read: true } });
  }

  return Response.json({ ok: true });
}
