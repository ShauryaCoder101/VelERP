import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";
import { sendTaskAssignedEmail } from "../../../lib/email";

export async function GET(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const tasks = await prisma.task.findMany({
    where: { assignedTo: userId },
    // The assigner's name is all a task row shows; the unselected default carries their hash.
    include: { assignedByUser: { select: { name: true } } },
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

  /* The picker already hides people who have left, but the client can be stale or
     bypassed entirely — this is the gate that actually decides. */
  const assignee = body.assignedTo
    ? await prisma.user.findUnique({
        where: { id: body.assignedTo },
        select: { status: true, role: true }
      })
    : null;
  if (!assignee || assignee.status !== "ACTIVE") {
    return new Response("Cannot assign a task to an inactive user", { status: 400 });
  }
  /* Photographers are third-party contractors whose only reach into the ERP is uploading
     to their granted events — internal work cannot be handed to them. */
  if (assignee.role === "PHOTOGRAPHER") {
    return new Response("Cannot assign a task to a photographer", { status: 400 });
  }

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
