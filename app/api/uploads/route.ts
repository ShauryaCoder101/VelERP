import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";

export async function GET() {
  const uploads = await prisma.upload.findMany({
    include: { event: true, user: true },
    orderBy: { createdAt: "desc" }
  });
  return Response.json(uploads);
}

export async function POST(request: Request) {
  const { role, id: userId } = await getRequestUser(request);
  if (!requireMinLevel(role, 3) && role !== "Photographer") {
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
