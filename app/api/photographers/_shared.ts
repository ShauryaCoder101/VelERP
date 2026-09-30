import { PHOTOGRAPHER_QUOTA_BYTES } from "../../../lib/photographers";

/* Shared between the collection route and the per-account route. Underscore-prefixed so
   the App Router treats it as a private file rather than a segment, and kept out of
   route.ts because Next type-checks route modules for unexpected exports. */

export const MIN_PASSWORD_LENGTH = 10;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const photographerSelect = {
  id: true,
  uid: true,
  name: true,
  email: true,
  status: true,
  createdAt: true,
  photographerProfile: {
    select: {
      allocatedBytes: true,
      quotaBytes: true,
      creator: { select: { id: true, name: true } }
    }
  },
  photographerAccess: {
    where: { revokedAt: null },
    select: {
      grantedAt: true,
      event: { select: { id: true, eventName: true, companyName: true, fromDate: true, toDate: true } },
      grantedBy: { select: { id: true, name: true } }
    },
    orderBy: { grantedAt: "desc" as const }
  }
} as const;

export type PhotographerRow = {
  id: string;
  uid: string;
  name: string;
  email: string;
  status: string;
  createdAt: Date;
  photographerProfile: {
    allocatedBytes: bigint;
    quotaBytes: bigint;
    creator: { id: string; name: string } | null;
  } | null;
  photographerAccess: {
    grantedAt: Date;
    event: { id: string; eventName: string; companyName: string; fromDate: Date; toDate: Date };
    grantedBy: { id: string; name: string };
  }[];
};

/* BigInt cannot be serialised by Response.json — it throws rather than degrading — so the
   conversion happens here, at the one boundary every response passes through. Byte counts
   stay far below Number.MAX_SAFE_INTEGER, so nothing is lost. */
export const serializePhotographer = (row: PhotographerRow) => ({
  id: row.id,
  uid: row.uid,
  name: row.name,
  email: row.email,
  status: row.status,
  createdAt: row.createdAt,
  createdBy: row.photographerProfile?.creator ?? null,
  usedBytes: Number(row.photographerProfile?.allocatedBytes ?? 0n),
  quotaBytes: Number(row.photographerProfile?.quotaBytes ?? BigInt(PHOTOGRAPHER_QUOTA_BYTES)),
  events: row.photographerAccess.map((grant) => ({
    eventId: grant.event.id,
    eventName: grant.event.eventName,
    companyName: grant.event.companyName,
    fromDate: grant.event.fromDate,
    toDate: grant.event.toDate,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt
  }))
});
