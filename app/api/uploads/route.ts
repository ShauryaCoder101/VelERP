import { prisma } from "../../../lib/db";
import { getRequestUser } from "../../../lib/rbac-server";

export async function GET(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const eventId = new URL(request.url).searchParams.get("eventId");
  const uploads = await prisma.upload.findMany({
    where: eventId ? { eventId } : undefined,
    include: { event: true, user: true },
    orderBy: { createdAt: "desc" }
  });
  return Response.json(uploads);
}

export async function POST(request: Request) {
  // Anyone signed in can contribute media to an event.
  const { id: userId } = await getRequestUser(request);
  if (!userId) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const upload = await prisma.upload.create({
    data: {
      eventId: body.eventId,
      fileUrl: body.fileUrl,
      fileType: body.fileType,
      uploadedBy: userId
    }
  });
  return Response.json(upload);
}
