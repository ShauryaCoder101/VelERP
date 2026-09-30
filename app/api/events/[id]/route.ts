import { NextRequest } from "next/server";
import { prisma } from "../../../../lib/db";
import type { Prisma } from "@prisma/client";
import { getRequestUser, requireMinLevel } from "../../../../lib/rbac-server";
import { createNotification } from "../../../../lib/notifications";

/* Named fields rather than `include`, because `include` pulls every scalar and
   Upload.sizeBytes is a BigInt — which Response.json throws on. These five are
   exactly what the event page consumes: app/(dashboard)/events/[id]/page.tsx
   (UploadItem) and app/components/EventMedia.tsx (UploadRecord) read id,
   fileUrl, fileType, createdAt and user; sizeBytes is carried too, but only
   through serializeEvent below, which converts it. */
const uploadSelect = {
  id: true,
  fileUrl: true,
  fileType: true,
  createdAt: true,
  sizeBytes: true,
  user: { select: { id: true, name: true } }
} as const;

/* lib/db.ts installs a BigInt→JSON fallback, but this route is the one that
   actually breaks without a conversion, so it converts explicitly: the client
   gets `number | null`, which is what a JS consumer can do arithmetic on. */
const serializeEvent = <T extends { uploads: { sizeBytes: bigint | null }[] }>(event: T) => ({
  ...event,
  uploads: event.uploads.map((upload) => ({
    ...upload,
    sizeBytes: upload.sizeBytes === null ? null : Number(upload.sizeBytes)
  }))
});

const eventInclude = {
  vendors: { include: { vendor: true } },
  artists: { include: { artist: true } },
  teamMembers: { include: { user: { select: { id: true, name: true, designation: true, email: true } } } },
  uploads: { select: uploadSelect, orderBy: { createdAt: "desc" as const } },
  claims: {
    include: {
      user: { select: { id: true, name: true, designation: true } },
      items: true,
      attachments: true
    },
    orderBy: { createdAt: "desc" as const }
  },
  finances: {
    include: { vendor: { select: { id: true, companyName: true, work: true } } },
    orderBy: { createdAt: "asc" as const }
  },
  sanctions: {
    include: { user: { select: { id: true, name: true, designation: true } } },
    orderBy: { createdAt: "asc" as const }
  }
};

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  /* This payload carries expense-claim amounts and vendor finance — employees only. */
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const { id } = await context.params;
  const event = await prisma.event.findUnique({
    where: { id },
    include: eventInclude
  });
  if (!event) return new Response("Not found", { status: 404 });
  return Response.json(serializeEvent(event));
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role, id: userId } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id } = await context.params;
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) return new Response("Not found", { status: 404 });

  const isMD = requireMinLevel(role, 1) && !requireMinLevel(role, 0);
  const isOwner = event.createdBy === userId;
  if (!isMD && !isOwner) {
    return new Response("You can only delete events you created", { status: 403 });
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.eventVendor.deleteMany({ where: { eventId: id } });
    await tx.eventArtist.deleteMany({ where: { eventId: id } });
    await tx.eventTeamMember.deleteMany({ where: { eventId: id } });
    await tx.upload.deleteMany({ where: { eventId: id } });
    /* MediaShare.eventId is ON DELETE RESTRICT, so any event that ever had a
       client share link failed the event.delete below with P2003 (surfacing as a
       500) — the one child table the transaction never cleared. The share is a
       link to this event's media and is meaningless once the event is gone.
       PhotographerEventAccess needs nothing: its FK cascades. */
    await tx.mediaShare.deleteMany({ where: { eventId: id } });
    await tx.expenseItem.deleteMany({ where: { claim: { eventId: id } } });
    await tx.expenseAttachment.deleteMany({ where: { claim: { eventId: id } } });
    await tx.expenseClaim.deleteMany({ where: { eventId: id } });
    await tx.eventVendorFinance.deleteMany({ where: { eventId: id } });
    await tx.eventSanction.deleteMany({ where: { eventId: id } });
    await tx.event.delete({ where: { id } });
  });

  return Response.json({ ok: true });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { role, id: userId, name: userName } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const { id: eventId } = await context.params;

  /* PATCH replaces the roster wholesale, and it is the edit modal's actual write path,
     so the gate POST applies has to hold here too. Only ids being ADDED are checked:
     a stored roster may legitimately still name someone who has since left — we keep
     historic rosters intact — and re-saving one unchanged must not start failing.
     Deduplicated so a repeated id cannot fail the count check, and resolved in a
     single query rather than one per member. */
  /* EventTeamMember's primary key is (eventId, userId), so a duplicated id would make
     createMany throw — the write below must use this deduplicated array, not the raw body. */
  const teamMemberIds: string[] | null = Array.isArray(body.teamMemberIds)
    ? Array.from(new Set(body.teamMemberIds as string[]))
    : null;

  if (teamMemberIds) {
    const current = await prisma.eventTeamMember.findMany({
      where: { eventId },
      select: { userId: true }
    });
    const currentIds = new Set(current.map((m: { userId: string }) => m.userId));
    const addedIds = teamMemberIds.filter((memberId) => !currentIds.has(memberId));
    if (addedIds.length) {
      /* One query resolves both gates; the rows are needed anyway to tell the two failures
         apart, so the caller gets a message naming the actual problem. */
      const added = await prisma.user.findMany({
        where: { id: { in: addedIds } },
        select: { status: true, role: true }
      });
      if (added.length !== addedIds.length || added.some((m) => m.status !== "ACTIVE")) {
        return new Response("Cannot add an inactive user to the event team", { status: 400 });
      }
      /* Photographers get at an event through a PhotographerEventAccess grant, never by
         joining its roster — a roster seat would hand them the whole internal event record. */
      if (added.some((m) => m.role === "PHOTOGRAPHER")) {
        return new Response("Cannot add a photographer to the event team", { status: 400 });
      }
    }
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const updateData: Record<string, unknown> = {};
    if (body.companyName !== undefined) updateData.companyName = body.companyName;
    if (body.eventName !== undefined) updateData.eventName = body.eventName;
    if (body.pocName !== undefined) updateData.pocName = body.pocName;
    if (body.pocPhone !== undefined) updateData.pocPhone = body.pocPhone;
    if (body.phase !== undefined) updateData.phase = body.phase;
    if (body.fromDate) updateData.fromDate = new Date(body.fromDate);
    if (body.toDate) updateData.toDate = new Date(body.toDate);

    if (Object.keys(updateData).length > 0) {
      await tx.event.update({ where: { id: eventId }, data: updateData });
    }

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

    if (teamMemberIds) {
      await tx.eventTeamMember.deleteMany({ where: { eventId } });
      if (teamMemberIds.length) {
        await tx.eventTeamMember.createMany({
          data: teamMemberIds.map((userId: string) => ({ eventId, userId }))
        });
      }
    }
  });

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: eventInclude
  });

  if (body.phase === "FINISHED" && event) {
    await createNotification(userId, "event_closed", "Event Closed", `${userName} closed event "${event.eventName}" for ${event.companyName}`);
  }

  /* PATCH re-reads through the same include, so its response carries the same
     BigInt and needs the same conversion. */
  return Response.json(event ? serializeEvent(event) : null);
}
