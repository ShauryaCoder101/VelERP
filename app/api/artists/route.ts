import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";

export async function GET() {
  const artists = await prisma.artist.findMany({
    include: { ratings: true },
    orderBy: { createdAt: "desc" }
  });
  return Response.json(artists);
}

export async function POST(request: Request) {
  const { role, id: userId } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const artist = await prisma.artist.create({
    data: {
      name: body.name,
      phone: body.phone,
      category: body.category,
      location: body.location ?? null,
      socialLink: body.socialLink ?? null,
      status: body.status,
      currentEvent: body.currentEvent ?? null,
      lastEvent: body.lastEvent ?? null,
      onboardedBy: userId
    }
  });

  return Response.json(artist);
}
