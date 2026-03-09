import { NextRequest } from "next/server";
import { prisma } from "../../../../lib/db";
import type { Prisma } from "@prisma/client";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";

const eventInclude = {
  vendors: { include: { vendor: true } },
  artists: { include: { artist: true } },
  teamMembers: { include: { user: { select: { id: true, name: true, designation: true, email: true } } } },
  uploads: { include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" as const } }
};

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const event = await prisma.event.findUnique({
    where: { id },
    include: eventInclude
  });
  if (!event) return new Response("Not found", { status: 404 });
  return Response.json(event);
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const { id: eventId } = await context.params;

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

    if (Array.isArray(body.teamMemberIds)) {
      await tx.eventTeamMember.deleteMany({ where: { eventId } });
      if (body.teamMemberIds.length) {
        await tx.eventTeamMember.createMany({
          data: body.teamMemberIds.map((userId: string) => ({ eventId, userId }))
        });
      }
    }
  });

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: eventInclude
  });
  return Response.json(event);
}
