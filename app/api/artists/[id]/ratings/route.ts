import { NextRequest } from "next/server";
import { prisma } from "../../../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../../../lib/rbac-server";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  // This endpoint was previously unauthenticated (request param was ignored).
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const { id } = await context.params;
  const ratings = await prisma.rating.findMany({
    where: { artistId: id },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" }
  });
  return Response.json(ratings);
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role, id: userId } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id } = await context.params;
  const body = await request.json();
  const rating = await prisma.rating.create({
    data: {
      artistId: id,
      rating: Number(body.rating),
      remarks: body.remarks ?? null,
      userId
    }
  });

  return Response.json(rating);
}
