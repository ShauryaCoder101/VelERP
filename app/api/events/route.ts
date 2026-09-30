import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";
import { createNotification } from "../../../lib/notifications";

export async function GET() {
  const events = await prisma.event.findMany({
    include: {
      vendors: { include: { vendor: true } },
      artists: { include: { artist: true } },
      teamMembers: { include: { user: { select: { id: true, name: true, designation: true, email: true } } } }
    },
    orderBy: [{ fromDate: "desc" }]
  });
  return Response.json(events);
}

export async function POST(request: Request) {
  const { role, id: userId, name: userName } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();

  /* The picker already hides people who have left, but the client can be stale or
     bypassed entirely — this is the gate that actually decides. Deduplicated so a
     repeated id cannot fail the count check, and resolved in a single query rather
     than one per member. */
  /* EventTeamMember's primary key is (eventId, userId), so a duplicated id would make the
     nested create throw — the create below must use this deduplicated array, not the raw body. */
  const memberIds: string[] = Array.from(new Set((body.teamMemberIds ?? []) as string[]));

  if (memberIds.length) {
    const activeCount = await prisma.user.count({
      where: { id: { in: memberIds }, status: "ACTIVE" }
    });
    if (activeCount !== memberIds.length) {
      return new Response("Cannot add an inactive user to the event team", { status: 400 });
    }
  }

  const event = await prisma.event.create({
    data: {
      companyName: body.companyName,
      eventName: body.eventName,
      pocName: body.pocName,
      pocPhone: body.pocPhone,
      phase: body.phase,
      fromDate: new Date(body.fromDate),
      toDate: new Date(body.toDate),
      createdBy: userId,
      vendors: body.vendorIds?.length
        ? { create: body.vendorIds.map((vendorId: string) => ({ vendor: { connect: { id: vendorId } } })) }
        : undefined,
      artists: body.artistIds?.length
        ? { create: body.artistIds.map((artistId: string) => ({ artist: { connect: { id: artistId } } })) }
        : undefined,
      teamMembers: memberIds.length
        ? { create: memberIds.map((userId: string) => ({ user: { connect: { id: userId } } })) }
        : undefined
    },
    include: {
      vendors: { include: { vendor: true } },
      artists: { include: { artist: true } },
      teamMembers: { include: { user: { select: { id: true, name: true, designation: true, email: true } } } }
    }
  });

  await createNotification(userId, "event_added", "New Event Created", `${userName} created event "${event.eventName}" for ${event.companyName}`);
  return Response.json(event);
}
