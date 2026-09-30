import { PrismaClient } from "@prisma/client";

/* Prisma hands back a JS `bigint` for 64-bit columns (Upload.sizeBytes,
   PhotographerProfile.quotaBytes/allocatedBytes), and JSON.stringify — which is
   what Response.json calls — THROWS "Do not know how to serialize a BigInt"
   rather than degrading. Without this, any route that forgets an explicit
   conversion returns a 500 instead of data, and the failure only appears once a
   row actually has a value. Routes still convert at their own edge; this is the
   net under them.

   Number() is exact below 2^53 — about 9 petabytes as a byte count — so no file
   size or quota in this system can lose precision.

   `??=` keeps it idempotent: this module is re-evaluated on every dev hot
   reload, and re-assigning a prototype method each time is pointless churn. */
(BigInt.prototype as unknown as { toJSON?: () => number }).toJSON ??= function (this: bigint) {
  return Number(this);
};

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error", "warn"]
  });

globalForPrisma.prisma = prisma;
