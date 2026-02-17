import { prisma } from "../../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../../lib/rbac-server";

export async function GET(_: Request, context: { params: { id: string } }) {
  const ratings = await prisma.rating.findMany({
    where: { artistId: context.params.id },
    include: { user: true },
    orderBy: { createdAt: "desc" }
  });
  return Response.json(ratings);
}

export async function POST(request: Request, context: { params: { id: string } }) {
  const { role, id: userId } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const rating = await prisma.rating.create({
    data: {
      artistId: context.params.id,
      rating: Number(body.rating),
      remarks: body.remarks ?? null,
      userId
    }
  });

  return Response.json(rating);
}
