import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";
import { sendTaskAssignedEmail } from "../../../lib/email";

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
    },
    include: {
      assignedToUser: { select: { name: true, email: true } },
      assignedByUser: { select: { name: true } }
    }
  });

  /* Tell the assignee straight away rather than waiting for the daily digest.
     Awaited so a send failure is logged during the request, but it can never
     fail the response — the task exists either way. Assigning something to
     yourself does not warrant an email. */
  if (task.assignedTo !== userId && task.assignedToUser?.email) {
    await sendTaskAssignedEmail({
      to: task.assignedToUser.email,
      assigneeName: task.assignedToUser.name,
      assignerName: task.assignedByUser.name,
      title: task.title,
      notes: task.notes,
      dueDate: task.dueDate
    });
  }

  return Response.json(task);
}
