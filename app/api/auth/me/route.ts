import { getSessionUser } from "../../../../lib/session";
import { prisma } from "../../../../lib/db";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }
  return Response.json(user);
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await request.json();
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      avatarUrl: body.avatarUrl !== undefined ? body.avatarUrl : undefined
    }
  });

  return Response.json(updated);
}
