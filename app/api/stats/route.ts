import { prisma } from "../../../lib/db";

export async function GET() {
  const [totalEvents, activeVendors, pendingClaims, teamMembers] = await Promise.all([
    prisma.event.count(),
    prisma.vendor.count({ where: { status: "ACTIVE" } }),
    prisma.expenseClaim.count({ where: { status: "INACTIVE" } }),
    prisma.user.count({ where: { status: "ACTIVE" } })
  ]);

  return Response.json({
    totalEvents,
    activeVendors,
    pendingClaims,
    teamMembers
  });
}
