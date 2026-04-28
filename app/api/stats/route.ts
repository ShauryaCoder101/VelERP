import { prisma } from "../../../lib/db";

export async function GET() {
  try {
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
  } catch (err: any) {
    console.error("Stats API error:", err?.message ?? err);
    return Response.json({
      totalEvents: 0,
      activeVendors: 0,
      pendingClaims: 0,
      teamMembers: 0,
      error: err?.message ?? "Unknown error"
    }, { status: 200 });
  }
}
