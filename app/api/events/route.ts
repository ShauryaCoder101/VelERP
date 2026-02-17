import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";

export async function GET() {
  const events = await prisma.event.findMany({
    include: {
      vendors: { include: { vendor: true } },
      artists: { include: { artist: true } }
    },
    orderBy: [{ fromDate: "desc" }]
  });
  return Response.json(events);
}

export async function POST(request: Request) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const event = await prisma.event.create({
    data: {
      companyName: body.companyName,
      eventName: body.eventName,
      pocName: body.pocName,
      pocPhone: body.pocPhone,
      phase: body.phase,
      fromDate: new Date(body.fromDate),
      toDate: new Date(body.toDate),
      vendors: body.vendorIds
        ? {
            create: body.vendorIds.map((vendorId: string) => ({
              vendor: { connect: { id: vendorId } }
            }))
          }
        : undefined,
      artists: body.artistIds
        ? {
            create: body.artistIds.map((artistId: string) => ({
              artist: { connect: { id: artistId } }
            }))
          }
        : undefined
    }
  });

  return Response.json(event);
}
