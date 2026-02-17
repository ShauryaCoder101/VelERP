import { prisma } from "../../../../lib/db";
import type { Prisma } from "@prisma/client";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";

export async function PATCH(request: Request, context: { params: { id: string } }) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const eventId = context.params.id;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.event.update({
      where: { id: eventId },
      data: {
        companyName: body.companyName,
        eventName: body.eventName,
        pocName: body.pocName,
        pocPhone: body.pocPhone,
        phase: body.phase,
        fromDate: body.fromDate ? new Date(body.fromDate) : undefined,
        toDate: body.toDate ? new Date(body.toDate) : undefined
      }
    });

    if (Array.isArray(body.vendorIds)) {
      await tx.eventVendor.deleteMany({ where: { eventId } });
      if (body.vendorIds.length) {
        await tx.eventVendor.createMany({
          data: body.vendorIds.map((vendorId: string) => ({ eventId, vendorId }))
        });
      }
    }

    if (Array.isArray(body.artistIds)) {
      await tx.eventArtist.deleteMany({ where: { eventId } });
      if (body.artistIds.length) {
        await tx.eventArtist.createMany({
          data: body.artistIds.map((artistId: string) => ({ eventId, artistId }))
        });
      }
    }
  });

  const event = await prisma.event.findUnique({ where: { id: eventId } });
  return Response.json(event);
}
