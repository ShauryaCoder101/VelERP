import bcrypt from "bcryptjs";
import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";

export async function GET(request: Request) {
  const { id: userId, role } = await getRequestUser(request);
  if (!userId) {
    return new Response("Forbidden", { status: 403 });
  }

  /* This one endpoint feeds both the admin panel, which has to see people who have
     left in order to reactivate them, and every "assign to" picker, which must not
     offer them. Inactive rows are therefore opt-in and only for admins. */
  const includeInactive =
    new URL(request.url).searchParams.get("includeInactive") === "1" &&
    requireMinLevel(role, 2);

  const users = await prisma.user.findMany({
    where: includeInactive ? undefined : { status: "ACTIVE" },
    select: {
      id: true,
      uid: true,
      name: true,
      email: true,
      designation: true,
      role: true,
      team: true,
      status: true,
      avatarUrl: true,
      createdAt: true
    },
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
  const password = body.password ?? "ChangeMe123!";
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      uid: body.uid,
      name: body.name,
      email: body.email,
      designation: body.designation,
      role: body.role,
      team: body.team ?? null,
      status: body.status ?? "ACTIVE",
      passwordHash
    },
    // Without an explicit select the response would echo back the bcrypt hash we just made.
    select: {
      id: true,
      uid: true,
      name: true,
      email: true,
      designation: true,
      role: true,
      team: true,
      avatarUrl: true,
      status: true,
      createdAt: true
    }
  });
  return Response.json(user);
}
