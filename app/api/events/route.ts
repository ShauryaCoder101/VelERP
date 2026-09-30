import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";
import { createNotification } from "../../../lib/notifications";

export async function GET(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

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
    /* One query resolves both gates; the rows are needed anyway to tell the two failures
       apart, so the caller gets a message naming the actual problem. */
    const members = await prisma.user.findMany({
      where: { id: { in: memberIds } },
      select: { status: true, role: true }
    });
    if (members.length !== memberIds.length || members.some((m) => m.status !== "ACTIVE")) {
      return new Response("Cannot add an inactive user to the event team", { status: 400 });
    }
    /* Photographers get at an event through a PhotographerEventAccess grant, never by
       joining its roster — a roster seat would hand them the whole internal event record. */
    if (members.some((m) => m.role === "PHOTOGRAPHER")) {
      return new Response("Cannot add a photographer to the event team", { status: 400 });
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
