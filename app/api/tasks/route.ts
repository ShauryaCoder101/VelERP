import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";

export async function GET(request: Request) {
  const { id: userId } = await getRequestUser(request);
  const tasks = await prisma.task.findMany({
    where: { assignedTo: userId },
    include: { assignedByUser: true },
    orderBy: { createdAt: "desc" }
  });
  return Response.json(tasks);
}

export async function POST(request: Request) {
  const { role, id: userId } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const task = await prisma.task.create({
    data: {
      title: body.title,
      notes: body.notes ?? null,
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      assignedBy: userId,
      assignedTo: body.assignedTo
    }
  });
  return Response.json(task);
}
