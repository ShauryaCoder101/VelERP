import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";

export async function GET() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" }
  });
  return Response.json(users);
}

export async function POST(request: Request) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 2)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const user = await prisma.user.create({
    data: {
      uid: body.uid,
      name: body.name,
      email: body.email,
      designation: body.designation,
      role: body.role,
      team: body.team ?? null,
      status: body.status ?? "ACTIVE"
    }
  });
  return Response.json(user);
}
