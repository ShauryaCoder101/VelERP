import { prisma } from "../../../lib/db";
import { getRequestUser, requireMinLevel } from "../../../lib/rbac-server";
import { createNotification } from "../../../lib/notifications";

export async function GET() {
  const vendors = await prisma.vendor.findMany({
    include: { ratings: true },
    orderBy: { createdAt: "desc" }
  });
  return Response.json(vendors);
}

export async function POST(request: Request) {
  const { role, id: userId, name: userName } = await getRequestUser(request);
  if (!requireMinLevel(role, 3)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json();
  const vendor = await prisma.vendor.create({
    data: {
      companyName: body.companyName,
      email: body.email || null,
      location: body.location ?? null,
      phone: body.phone,
      work: body.work,
      gstin: body.gstin ?? null,
      status: body.status,
      currentEvent: body.currentEvent ?? null,
      onboardedBy: userId
    }
  });

  await createNotification(userId, "vendor", "New Vendor Added", `${userName} added vendor "${vendor.companyName}"`);
  return Response.json(vendor);
}
