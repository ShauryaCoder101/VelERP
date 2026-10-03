import crypto from "crypto";
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { prisma } from "../../../../lib/db";
import { getProfile, type StorageProfile } from "../../../../lib/storage";
import {
  folderPathRejection,
  getUploadActor,
  keyWithinRoot,
  pathUnderRoot,
  type UploadActor
} from "../../../../lib/upload-links";
import { buildUploadKey } from "../../../../lib/uploadKey";
import { MULTIPART_THRESHOLD, partSizeFor } from "../../../../lib/upload-client";
import { allocateQuota, claimSweepSlot, hasEventAccess, releaseQuota } from "../../../../lib/photographers";
import { PART_EXPIRY_SECONDS, sweepFirmMultipart } from "../../../../lib/multipart-janitor";
import { uploadHmacKey, verifyReservation } from "../../../../lib/uploadReservation";

/* Multipart upload for anything large enough that losing it midway hurts.
 *
 * A single presigned PUT is all-or-nothing: a dropped connection at 900MB of a
 * 1GB file means starting over, and it caps out at 5GB regardless. Splitting the
 * file lets a failed part be retried on its own, so a blip costs one chunk
 * rather than the whole upload.
 *
 * The browser drives it; this route only mints signatures and finalises.
 *
 * Every part signature carries a Content-Length, so the declared file size is
 * the size that can actually be uploaded — otherwise the quota charged at
 * create time would be a number the client picked rather than a limit.
 *
 * State and money live in MultipartSession, not in the ticket. The ticket is a
 * bearer value with a week's life, and R2's AbortMultipartUpload is idempotent:
 * aborting the same upload a second and third time both return success. Paying
 * a refund on that answer meant a photographer could loop abort and reset their
 * usage to zero, which made the 1 TB ceiling decorative. The refund now rides on
 * an OPEN -> ABORTED row transition, which exactly one caller can ever win. */

/* How long a part signature lives — long uploads must outlive their signatures.
   Defined next to the inactivity threshold derived from it (lib/multipart-
   janitor.ts), because the two cannot be allowed to drift apart. */
const PART_EXPIRY = PART_EXPIRY_SECONDS;
const TICKET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/* How much of a firm's quota may sit charged against multipart uploads that
 * have not landed yet — in THREE tiers for link traffic, plus a separate pool
 * for the firm's own login. The same shape as the unsettled-presign ceilings in
 * lib/upload-charges.ts, and for the same reasons.
 *
 * `create` charges the declared size before a byte exists, so these have to
 * exist: an open link is reachable by anyone the URL was forwarded to, and one
 * POST declaring a terabyte would otherwise pin the firm's whole ceiling.
 *
 *   per contributor (64 GB)  one person at one laptop: two 32 GB masters in
 *                            flight at once, past anything a camera produces.
 *   per link (128 GB)        a link is ONE bearer URL that may have been handed
 *                            to a whole crew. Two contributors at their own
 *                            ceiling fill it.
 *   all links (250 GB)       everything that arrived through any link. Two
 *                            links at their own ceiling (256 GB) overrun it, so
 *                            the tier is load-bearing rather than decorative.
 *
 * 250 GB used to be the firm-wide figure including the main login, and the
 * comment here claimed four contributors at 64 GB could not exhaust it — 4 x 64
 * is 256, so they could, and the first thing they exhausted was the firm's own
 * ability to upload. The main login now has its OWN 250 GB and is checked
 * against nothing a link holder does: it is the firm itself rather than a
 * forwarded URL. The two pools together can reach 500 GB, half the 1 TB
 * ceiling, which is the price of that separation; the 1 TB allocation check
 * still bounds the sum, so no amount of pending can overcommit the account.
 *
 * What the separation guarantees is narrower than "a link can never lock the
 * firm out of its own account", and the distinction is worth stating because
 * the code does not deliver the wider claim. It guarantees that no link can
 * make the main login fail THESE tiers. allocateQuota runs first, in the same
 * transaction, and draws on the single shared 1 TB: four `create` calls plus
 * ~14 `sign` calls a day hold 250 GiB of it for the ~6.4 days a 64 GiB
 * declaration earns under the janitor's age bound, with zero bytes stored. On a
 * firm already carrying 750 GB of real media the main login's next
 * allocateQuota then fails with 403 "Upload limit reached" — not a 429, and not
 * from any tier here. Revoking the link does clear it (sign stops resolving,
 * the sessions go inactive and are swept within 7 h), which is why the tiers
 * are judged sufficient; a reserved slice of the 1 TB for the main login is the
 * thing that would make the wider claim true, and it does not exist.
 *
 * Dead sessions recycle within hours rather than days (sweepFirmMultipart
 * below, on the inactivity rule), so none of these has to double as a
 * reservation system — they only have to stop a flood.
 *
 * They are measured INSIDE the charging transaction, after allocateQuota has
 * taken the firm's PhotographerProfile row lock. Read before it, as separate
 * statements, they were per-request checks and not caps at all: three
 * concurrent creates each declaring the full 250 GB all read pending = 0, all
 * passed, and 750 GB of a 1 TB ceiling went to sessions holding no bytes. */
const GiB = 1024 * 1024 * 1024;
const MAX_PENDING_PER_CONTRIBUTOR_BYTES = 64 * GiB;
const MAX_PENDING_PER_LINK_BYTES = 128 * GiB;
const MAX_PENDING_LINK_BYTES = 250 * GiB;
const MAX_PENDING_MAIN_BYTES = 250 * GiB;

/* Whose limit was hit, in words the reader can act on — the same distinction
   the presign 429s draw. "Finish or cancel those first" is advice only the
   person actually holding the uploads can take. */
const PENDING_MESSAGE = {
  contributor: "You have too many uploads still in progress — finish or cancel those first.",
  link: "This link has too many uploads still in progress. Wait for them to finish, or ask for a link of your own.",
  links: "This firm's upload links have too many uploads still in progress. Please try again shortly.",
  main: "Too many of your uploads are still in progress — finish or cancel those first."
} as const;

/* The pending tiers one `create` is held to, cheapest first, so an actor over
   several of them hears about the one closest to home — the one they can act on
   — and the common refusal costs one aggregate rather than three.

   A contributor is held to their own tier, their link's, and every link of the
   firm together. The firm's main login is held to its own pool and to nothing a
   link holder does: rows it opened have a null contributorId, and "links"
   excludes them, so the two pools partition the firm's OPEN sessions.

   One definition, read twice: once outside the transaction as a cheap pre-check
   that can refuse before any storage call, and once inside it where the
   PhotographerProfile row lock makes it an actual ceiling. */
type PendingTier = { scope: object; limit: number; message: string };

const pendingTiersFor = (uploader: UploadActor): PendingTier[] =>
  uploader.contributor
    ? [
        {
          scope: { contributorId: uploader.contributor.id },
          limit: MAX_PENDING_PER_CONTRIBUTOR_BYTES,
          message: PENDING_MESSAGE.contributor
        },
        {
          scope: { linkId: uploader.contributor.linkId },
          limit: MAX_PENDING_PER_LINK_BYTES,
          message: PENDING_MESSAGE.link
        },
        {
          scope: { linkId: { not: null } },
          limit: MAX_PENDING_LINK_BYTES,
          message: PENDING_MESSAGE.links
        }
      ]
    : [{ scope: { contributorId: null }, limit: MAX_PENDING_MAIN_BYTES, message: PENDING_MESSAGE.main }];

const pendingBytes = async (
  db: Pick<typeof prisma, "multipartSession">,
  userId: string,
  scope: object
): Promise<number> => {
  const sum = await db.multipartSession.aggregate({
    where: { userId, state: "OPEN", ...scope },
    _sum: { bytesCharged: true }
  });
  return Number(sum._sum.bytesCharged ?? 0n);
};

/* A refusal raised from inside the charging transaction, so the allocation and
   the session row roll back together with it. */
class CreateRefused extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>
  ) {
    super("create refused");
  }
}

/* The ticket is what stops `sign` from being a signing oracle: without it a
   caller could pass any upload id and have us sign PUTs against someone else's
   upload. It is deliberately thin — an upload id, its owner and an expiry.
   The key, the part layout and the bytes charged are NOT in here: they are read
   from the session row on every call, so there is exactly one place that can be
   wrong and no tamper-proof-but-stale copy to disagree with it. */
type Ticket = {
  /** S3/R2 multipart upload id */
  u: string;
  /** user id the ticket belongs to */
  i: string;
  /** expiry, epoch ms */
  x: number;
};

/* Derived from the shared upload secret with a label mixed in, so an upload
   ticket, a key reservation and a client share token can never be replayed as
   one another even though all three are HMACs over the same key material. */
const ticketKey = () => uploadHmacKey("velocity-upload-ticket-v1");

const signTicket = (ticket: Ticket) => {
  const body = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  const sig = crypto.createHmac("sha256", ticketKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
};

const verifyTicket = (token: unknown): Ticket | null => {
  if (typeof token !== "string" || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(crypto.createHmac("sha256", ticketKey()).update(body).digest("base64url"));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  try {
    const ticket = JSON.parse(Buffer.from(body, "base64url").toString()) as Ticket;
    if (typeof ticket.u !== "string" || !ticket.u || typeof ticket.i !== "string") return null;
    if (typeof ticket.x !== "number" || Date.now() > ticket.x) return null;
    return ticket;
  } catch {
    return null;
  }
};

/* The part layout, derived from the stored sizes rather than from anything the
   client sent. Byte counts are far inside Number's exact range (9PB). */
type Layout = { fileSize: number; partSize: number; count: number };

const layoutOf = (row: { fileSize: bigint; partSize: bigint }): Layout => {
  const fileSize = Number(row.fileSize);
  const partSize = Number(row.partSize);
  return { fileSize, partSize, count: Math.max(1, Math.ceil(fileSize / partSize)) };
};

/** Every part is exactly partSize except the last, which is the remainder. */
const partLength = (layout: Layout, partNumber: number) =>
  partNumber === layout.count ? layout.fileSize - (layout.count - 1) * layout.partSize : layout.partSize;

const profileFor = (purpose: string) => getProfile(purpose === "media" ? "media" : "document");

/* Did an object already claim this key?
 *
 * A reservation is a 24-hour bearer value for ONE key, and nothing consumed it:
 * whoever held it could open a second multipart upload on a key they had
 * already completed and registered, and CompleteMultipartUpload would overwrite
 * the object in place. The Upload row still points at the same URL, so the
 * gallery, the client share link and the ZIP would all serve the new bytes
 * under the old filename. That is a replace, and a photographer must never be
 * able to replace a photo — but the rule is not about photographers: a key is
 * written once, by anyone, so employees are held to it too.
 *
 * Three questions, cheapest first, because any one of them saying yes is
 * enough:
 *   1. does another multipart upload hold the key (still running, or finished)?
 *   2. is there a registered file at it?  An original moved to Glacier by
 *      rclone is GONE from the hot bucket, so the row is the only thing left
 *      that knows the key is spoken for — question 3 would say "free".
 *   3. is there simply an object there?  Catches everything that never became
 *      a row, including a single-PUT original whose registration is still in
 *      flight.
 *
 * "unknown" is storage failing to answer. Refuse then as well: guessing "free"
 * is how an overwrite gets through, and the caller can retry in a moment. */
type KeyState = "free" | "taken" | "unknown";

const keyState = async (profile: StorageProfile, key: string, eventId: string): Promise<KeyState> => {
  // (key, state) is indexed; without that this read every OPEN and COMPLETED
  // row in the table, and COMPLETED rows are never deleted.
  const session = await prisma.multipartSession.findFirst({
    where: { key, state: { in: ["OPEN", "COMPLETED"] } },
    select: { uploadId: true }
  });
  if (session) return "taken";

  /* Upload.fileUrl is stored exactly as it was handed to the browser — this
     same concatenation — so the plain form is the one that matches. The
     percent-encoded form is checked too, for any caller that normalised the URL
     before registering it; keys can contain spaces.

     Scoped to the event, which costs nothing — the key is built from the event
     id, so a row with this fileUrl under another event cannot exist — and buys
     the (eventId, fileUrl) index. Unscoped this was a sequential scan of every
     Upload row in the ERP, reachable by anyone holding a forwarded link, before
     any quota or ceiling check. */
  const plain = `${profile.publicBaseUrl}/${key}`;
  const encoded = `${profile.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const registered = await prisma.upload.findFirst({
    where: { eventId, fileUrl: { in: plain === encoded ? [plain] : [plain, encoded] } },
    select: { id: true }
  });
  if (registered) return "taken";

  try {
    await profile.client.send(new HeadObjectCommand({ Bucket: profile.bucket, Key: key }));
    return "taken";
  } catch (error) {
    // The SDK throws on a 404, so "definitely absent" arrives as an exception
    // too. Only that one means free; everything else is storage not answering.
    const notFound =
      (error as { name?: string }).name === "NotFound" ||
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
    return notFound ? "free" : "unknown";
  }
};

/* sign / complete / abort all start the same way: a valid ticket for this user,
   and the session row it names. The row, not the ticket, is the source of
   truth — it is what says whether this upload is still live. */
const openSession = async (body: any, uploader: UploadActor) => {
  const ticket = verifyTicket(body.token);
  if (!ticket) {
    return { error: Response.json({ error: "This upload has expired — please start it again" }, { status: 403 }) } as const;
  }
  if (ticket.i !== uploader.id) {
    return { error: Response.json({ error: "This upload belongs to someone else" }, { status: 403 }) } as const;
  }

  const session = await prisma.multipartSession.findUnique({ where: { uploadId: ticket.u } });
  /* Same answer for "no such row" and "someone else's row": a caller holding a
     forged-but-unverifiable id learns nothing about what exists.

     contributorId is part of "whose row". Every contributor of a firm presents
     the SAME user id — the firm's — so userId alone stops distinguishing them
     the moment open links exist, and one of a firm's photographers could sign
     parts into, complete, or abort another's upload. A session opened by a
     contributor is answerable only to that contributor; one opened by the main
     login or an employee has a null here and is answerable only to a caller
     with no contributor. */
  if (!session || session.userId !== uploader.id) {
    return { error: Response.json({ error: "This upload is no longer available" }, { status: 409 }) } as const;
  }
  if (session.contributorId !== (uploader.contributor?.id ?? null)) {
    return { error: Response.json({ error: "This upload is no longer available" }, { status: 409 }) } as const;
  }

  const profile = profileFor(session.purpose);
  if (!profile) return { error: Response.json({ error: "Storage is not configured" }, { status: 500 }) } as const;
  return { session, profile } as const;
};

export async function POST(request: Request) {
  // See the note in /api/uploads/presign: a contributor's actor carries the
  // FIRM's id, so quota, grants and tickets are unchanged; what it adds is the
  // uploadRoot every key has to sit under, and the contributor the session binds to.
  const uploader = await getUploadActor(request);
  if (!uploader) return new Response("Forbidden", { status: 403 });

  /* Parsed defensively: an empty or malformed POST must come back as a 400 the
     caller can read, not an unhandled throw Next renders as a 500 — checked before
     body.action is touched. (Same hardening as /api/share POST.) */
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  switch (body.action) {
    /* Reserve the key, charge the quota, and open the upload. */
    case "create": {
      const purpose: "media" | "document" = body.purpose === "media" ? "media" : "document";
      const eventId = String(body.eventId ?? "general");

      const fileSize = Number(body.fileSize);
      if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
        return Response.json({ error: "fileSize is required" }, { status: 400 });
      }

      /* A multipart upload has to be worth being multipart.
       *
       * The pending tiers below ration BYTES, so `{fileSize: 1}` could never
       * trip them: every call succeeded, wrote a MultipartSession row the
       * janitor will not look at for seven hours, and opened a real R2
       * multipart upload. Rows accumulate at three orders of magnitude more
       * than the janitor's 500-a-day budget reclaims, and MultipartSession rows
       * are never deleted once COMPLETED, so each one made every future create
       * permanently more expensive.
       *
       * This is not a new restriction on any real client: presign routes
       * anything at or below MULTIPART_THRESHOLD to a single PUT and does not
       * even issue the multipart branch for it (lib/upload-client.ts uploadFile
       * makes the same split), so a 1-byte multipart create is not something
       * this product produces. */
      if (fileSize <= MULTIPART_THRESHOLD) {
        return Response.json(
          { error: "That file is small enough to upload in one piece" },
          { status: 400 }
        );
      }

      // A link authorises ONE event; the firm behind it may hold several.
      if (uploader.contributor && uploader.contributor.eventId !== eventId) {
        return Response.json({ error: "This link is for a different event" }, { status: 403 });
      }

      if (uploader.isPhotographer) {
        if (purpose !== "media") {
          return Response.json({ error: "You can only upload event media" }, { status: 403 });
        }
        if (!(await hasEventAccess(uploader.id, eventId))) {
          return Response.json({ error: "You don't have access to this event" }, { status: 403 });
        }
      }

      const profile = profileFor(purpose);
      if (!profile) return Response.json({ error: "Storage is not configured" }, { status: 500 });

      /* The key is settled before any money moves, so an unusable reservation
         costs a 400 rather than a charge that then has to be unwound.

         A reservation is presign's key, handed over via the browser but signed
         so the browser cannot choose it. Minting a second key here is what left
         every file over 16MB without a thumbnail: presign signs the thumb and
         preview slots against its key, and derivativeUrlFor() looks for them
         under the original's key, so the two must be the same string. */
      let key: string;
      if (body.reservation !== undefined && body.reservation !== null) {
        const reserved = verifyReservation(body.reservation, { userId: uploader.id, eventId, purpose });
        if (!reserved) {
          return Response.json({ error: "This upload could not be verified — please try again" }, { status: 400 });
        }
        key = reserved;
      } else {
        // Legacy callers that never went through presign still get a fresh key.
        const fileName = String(body.fileName ?? "upload");
        const folder = pathUnderRoot(uploader.uploadRoot, String(body.relativePath ?? ""));
        // Same ceilings presign applies, and for the same reason: a key storage
        // will refuse must not be charged for first.
        const rejection = folderPathRejection(folder, eventId, fileName, {
          limitDepth: uploader.uploadRoot !== null
        });
        if (rejection) return Response.json({ error: rejection }, { status: 400 });
        key = buildUploadKey(eventId, folder, fileName);
      }

      /* A reservation proves the key came from presign and names this USER —
         but every contributor of a firm IS that user, so on its own it lets one
         of a firm's photographers spend another's reservation and write into
         their folder, or the firm's root. The root check is what separates
         them. Applied to the freshly built key too, which costs nothing and
         means there is one place this rule lives rather than two. */
      if (!keyWithinRoot(key, eventId, uploader.uploadRoot)) {
        return Response.json({ error: "That folder is not yours to upload to" }, { status: 403 });
      }

      /* Spend the reservation, or refuse. Before the quota is touched, so a
         refusal costs nothing and there is no charge to unwind — and before
         CreateMultipartUpload, so no parts are left in the bucket either.

         This is a check, not a lock: two creates for one key can both pass it.
         `complete` closes that window under an advisory lock; here the point is
         that the ordinary reuse — a reservation replayed hours later against a
         key that is now a photo in the gallery — never gets as far as opening
         an upload. */
      const state = await keyState(profile, key, eventId);
      if (state === "taken") {
        return Response.json({ error: "This file has already been uploaded" }, { status: 409 });
      }
      if (state === "unknown") {
        return Response.json({ error: "Storage is unavailable — please try again" }, { status: 503 });
      }

      if (uploader.isPhotographer) {
        /* Recycle this firm's own dead sessions before measuring what it has
           pending. A session is only swept once it provably cannot continue —
           no part URL it ever received is still valid, or it is past the age
           bound its own declared size earns it — so this never touches a live
           upload, however long that upload has been running.

           Before the pending check rather than after, for the same reason the
           charge sweep sits before the charge: the pending total IS a measure
           of dead sessions, so sweeping is not work done alongside the
           decision, it is the thing that changes it. Everything cheap has
           already refused above — the event, the grant, the reservation, the
           root, and keyState, which is the expensive one.

           What keeps a flood from buying one sweep per request is the slot
           claim: at most one caller per firm per minute does the work, and it
           is the same slot the presign charge sweep uses, because a flood
           reaches both doors. Never fatal either way. */
        if (await claimSweepSlot(uploader.id).catch(() => false)) {
          await sweepFirmMultipart(uploader.id).catch(() => {});
        }

        /* A NON-AUTHORITATIVE read of the pending tiers, purely to shed a flood
         * before it costs anything at storage.
         *
         * The authoritative check stays exactly where it is, inside the
         * transaction and behind the PhotographerProfile row lock, because that
         * lock is the only thing that makes it a ceiling rather than a snapshot
         * every concurrent request shares. But it runs AFTER
         * CreateMultipartUpload, so a request destined for a 429 was still
         * paying keyState's HEAD, the CreateMultipartUpload, and then the
         * compensating AbortMultipartUpload — three billed R2 operations for one
         * rejected request, and a caller that has already filled a tier can
         * repeat that indefinitely.
         *
         * Reading the same tiers here first costs the aggregates (indexed on
         * (userId, state)) and refuses with the same message and the same
         * status. It can be stale in both directions and neither matters: a
         * false pass is caught by the authoritative check a moment later, and a
         * false refusal is a 429 the caller retries, which is what an actual
         * ceiling would have told them anyway.
         *
         * After the sweep, deliberately — the sweep is what frees the pending
         * space, so a pre-check in front of it would refuse requests that are
         * about to become affordable. */
        for (const { scope, limit, message } of pendingTiersFor(uploader)) {
          if ((await pendingBytes(prisma, uploader.id, scope)) + fileSize > limit) {
            return Response.json({ error: message }, { status: 429 });
          }
        }
      }

      const partSize = partSizeFor(fileSize);

      /* Storage first, money second.
       *
       * The old order was allocateQuota, then CreateMultipartUpload, then the
       * session row: three statements, and an allocation that outlived the
       * request if anything stopped between them. The two compensating
       * releaseQuota calls only covered a thrown error, and a Vercel function
       * hitting its wall-clock limit or an instance being recycled throws
       * nothing. A 200 GB declaration could leave +200 GB on allocatedBytes
       * with no MultipartSession and no UploadCharge row — nothing the abort
       * endpoint, either multipart sweep or the charge sweep could ever find —
       * which is precisely the failure the ledger exists to abolish.
       *
       * Opening the upload first inverts the risk into the harmless direction.
       * A multipart upload with no parts stores nothing, is not an object (so
       * it never makes the key look taken), costs nothing, and is discarded by
       * the bucket's own incomplete-upload expiry. Everything that moves money
       * now happens in ONE transaction below, so the allocation exists if and
       * only if the row that records it does. */
      const created = await profile.client.send(
        new CreateMultipartUploadCommand({
          Bucket: profile.bucket,
          Key: key,
          ContentType: body.fileType || "application/octet-stream"
        })
      );
      if (!created.UploadId) throw new Error("storage returned no upload id");
      const uploadId = created.UploadId;

      try {
        await prisma.$transaction(async (tx) => {
          let charged = 0;

          if (uploader.isPhotographer) {
            /* The allocation goes first because its UPDATE takes this firm's
               PhotographerProfile row lock, which is what serialises the firm's
               creates. Every pending total read after it is therefore read
               alone: a concurrent create is still blocked here, and when it
               unblocks it sees this session row committed. */
            const quota = await allocateQuota(uploader.id, fileSize, tx);
            if (!quota.ok) {
              throw new CreateRefused(403, {
                error: "Upload limit reached",
                usedBytes: quota.usedBytes,
                quotaBytes: quota.quotaBytes
              });
            }
            charged = fileSize;

            /* The authoritative pass over the same tiers the pre-check above
               read, now behind the row lock that serialises the firm's creates.
               This session's own row is not inserted yet, so its bytes are
               added. */
            for (const { scope, limit, message } of pendingTiersFor(uploader)) {
              if ((await pendingBytes(tx, uploader.id, scope)) + fileSize > limit) {
                throw new CreateRefused(429, { error: message });
              }
            }
          }

          /* Without this row the upload is unusable: sign, complete and abort
             all refuse an upload they cannot find, and neither sweep would ever
             see it to reclaim the bytes. Written with the allocation, so one
             cannot exist without the other. */
          await tx.multipartSession.create({
            data: {
              uploadId,
              userId: uploader.id,
              key,
              eventId,
              purpose,
              fileSize: BigInt(fileSize),
              partSize: BigInt(partSize),
              bytesCharged: BigInt(charged),
              /* Stamped here and refreshed by every `sign`. The sweep reads it to
                 know when no part URL this session received can still be used, so
                 it has to start out set rather than relying on createdAt. */
              lastActivityAt: new Date(),
              // Null for the firm's main login and for employees; openSession
              // requires the caller to present exactly this again.
              contributorId: uploader.contributor?.id ?? null,
              /* The link the contributor came through, for the per-link tier of
                 the pending ceiling above. Not an authorisation check — the
                 contributor id is — so nothing re-presents it. */
              linkId: uploader.contributor?.linkId ?? null
            }
          });
        });
      } catch (error) {
        /* The transaction rolled back, so nothing is charged and no row exists.
           Discard the upload we opened — best effort, because an orphaned
           multipart upload holds no quota and no object. One compensation path
           now, for every way this can fail. */
        await profile.client
          .send(new AbortMultipartUploadCommand({ Bucket: profile.bucket, Key: key, UploadId: uploadId }))
          .catch(() => {});
        if (error instanceof CreateRefused) return Response.json(error.body, { status: error.status });
        throw error;
      }

      const ticket: Ticket = { u: uploadId, i: uploader.id, x: Date.now() + TICKET_TTL_MS };

      return Response.json({
        uploadId,
        key,
        fileUrl: `${profile.publicBaseUrl}/${key}`,
        token: signTicket(ticket),
        partSize,
        partCount: layoutOf({ fileSize: BigInt(fileSize), partSize: BigInt(partSize) }).count
      });
    }

    /* Sign a batch of part slots in one round trip. */
    case "sign": {
      const opened = await openSession(body, uploader);
      if ("error" in opened) return opened.error;
      const { session, profile } = opened;

      /* A finished or cancelled upload must not keep handing out PUT
         signatures: its parts are gone and its quota has been settled. */
      if (session.state !== "OPEN") {
        return Response.json({ error: "This upload was already finished or cancelled" }, { status: 409 });
      }

      const layout = layoutOf(session);
      const requested: unknown[] = Array.isArray(body.partNumbers) ? body.partNumbers.slice(0, 1000) : [];
      const parts: number[] = [];
      for (const raw of requested) {
        const partNumber = Number(raw);
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > layout.count) {
          return Response.json({ error: "Invalid part number" }, { status: 400 });
        }
        parts.push(partNumber);
      }

      const urls: Record<number, string> = {};
      await Promise.all(
        parts.map(async (partNumber) => {
          urls[partNumber] = await getSignedUrl(
            profile.client,
            new UploadPartCommand({
              Bucket: profile.bucket,
              Key: session.key,
              UploadId: session.uploadId,
              PartNumber: partNumber,
              // Signed: a part cannot carry more bytes than the declared layout allows.
              ContentLength: partLength(layout, partNumber)
            }),
            { expiresIn: PART_EXPIRY }
          );
        })
      );

      /* Record that this session was handed live signatures, AFTER they were
         minted: the stamp means "URLs valid from now for PART_EXPIRY exist", and
         a signing failure hands out none.

         Guarded on OPEN so a sign racing a sweep cannot put activity back on a
         row the sweep just settled — and the sweep winning is harmless anyway,
         because aborting the upload at storage makes every part PUT fail and the
         client's next call gets a clean 409 from the state check above. */
      await prisma.multipartSession
        .updateMany({
          where: { uploadId: session.uploadId, state: "OPEN" },
          data: { lastActivityAt: new Date() }
        })
        .catch(() => {});

      return Response.json({ urls });
    }

    /* Stitch the parts together. Order matters, so the client's list is sorted. */
    case "complete": {
      const opened = await openSession(body, uploader);
      if ("error" in opened) return opened.error;
      const { session, profile } = opened;

      /* Shape of the request is checked before the row is claimed. It touches
         no storage, and a client that sends a short list should get a 400 it
         can retry rather than a session wedged shut. */
      const layout = layoutOf(session);
      const given = Array.isArray(body.parts) ? body.parts : [];
      if (given.length !== layout.count) {
        return Response.json({ error: "Some parts are missing — please upload again" }, { status: 400 });
      }

      const parts = given
        .map((p: any) => ({ PartNumber: Number(p.partNumber), ETag: String(p.etag) }))
        .sort((a: any, b: any) => a.PartNumber - b.PartNumber);

      /* Claim the row BEFORE touching storage. Two completes in flight, or a
         complete racing an abort, both reach storage otherwise; only the one
         that moves OPEN -> COMPLETED is allowed to.

         The claim is per uploadId, so it settles two completes of the SAME
         upload but says nothing about two different uploads racing for one
         KEY — both would have passed create's check and both would call
         CompleteMultipartUpload, the second overwriting the first. The key is
         what needs serialising, so take a transaction-scoped advisory lock on
         it: whoever holds it decides, and it is released when the transaction
         ends, however it ends. hashtext collides in principle (32 bits), which
         costs two unrelated keys a moment of waiting and nothing else.

         A loser is left OPEN deliberately. Its parts are real and are being
         billed; leaving it claimable is what lets the client abort and get its
         bytes refunded through the one OPEN -> ABORTED transition. */
      const claim = await prisma.$transaction(async (tx) => {
        /* $executeRaw, never $queryRaw: pg_advisory_xact_lock returns `void`,
           which Prisma cannot deserialize, so $queryRaw threw here on every
           complete and every multipart upload (>16 MB) was aborted. */
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${session.key}::text))`;

        /* Excludes this session's own row, which is what keeps the "completed
           but the response was lost" recovery below working. That case has one
           session for the key: the claim moved it to COMPLETED, the SDK's
           internal retry of CompleteMultipartUpload got NoSuchUpload, and the
           catch branch HEADs the object and answers success. Nothing here sees
           a rival, because the only COMPLETED row for the key is this one.
           The same is true of the reopen path — it puts THIS row back to OPEN,
           so a genuine retry still finds no rival and can claim again. */
        const rival = await tx.multipartSession.findFirst({
          where: { key: session.key, state: "COMPLETED", uploadId: { not: session.uploadId } },
          select: { uploadId: true }
        });
        if (rival) return "taken" as const;

        const won = await tx.multipartSession.updateMany({
          where: { uploadId: session.uploadId, userId: uploader.id, state: "OPEN" },
          data: { state: "COMPLETED", closedAt: new Date() }
        });
        return won.count === 1 ? ("claimed" as const) : ("settled" as const);
      });

      if (claim === "taken") {
        return Response.json({ error: "This file has already been uploaded" }, { status: 409 });
      }
      if (claim === "settled") {
        return Response.json({ error: "This upload was already finished or cancelled" }, { status: 409 });
      }

      try {
        await profile.client.send(
          new CompleteMultipartUploadCommand({
            Bucket: profile.bucket,
            Key: session.key,
            UploadId: session.uploadId,
            MultipartUpload: { Parts: parts }
          })
        );
      } catch (error) {
        /* An error here does NOT mean the upload is still open. R2 can commit
           the object and lose the response on the way back; the SDK retries,
           the second CompleteMultipartUpload finds the upload gone, returns
           NoSuchUpload, and we land here over an object that exists. Reverting
           to OPEN then lets the client abort, and the abort refunds bytes that
           are stored and billed — a quota bypass.

           So ask storage what actually happened before deciding. Only an object
           that is definitively absent justifies reopening the row. */
        let committed = false;
        let certain = true;
        try {
          const head = await profile.client.send(
            new HeadObjectCommand({ Bucket: profile.bucket, Key: session.key })
          );
          // Size must match: a stale object at the same key from an earlier
          // attempt is not proof that THIS upload landed.
          committed = Number(head.ContentLength) === layout.fileSize;
        } catch (headError) {
          /* The SDK THROWS on a 404, so an object that is definitively absent
             lands here too. That is a certain answer — the upload never
             committed — so treat it as such and let the reopen branch run.
             Any OTHER failure (an unreachable bucket, say) is genuinely
             unknown: keep the row COMPLETED, because overcounting a
             photographer's usage is recoverable by hand while undercounting
             is the bypass. */
          const notFound =
            (headError as { name?: string }).name === "NotFound" ||
            (headError as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
          if (notFound) {
            committed = false;
          } else {
            certain = false;
          }
        }

        if (committed) {
          // The upload did finish. Leave the row COMPLETED and answer as success.
          return Response.json({ fileUrl: `${profile.publicBaseUrl}/${session.key}` });
        }

        if (certain) {
          /* The object is genuinely not there, so the upload really is still
             open at storage. Put the row back so the client can retry or abort
             — otherwise the parts sit in the bucket being billed with no way
             left to discard them.

             lastActivityAt moves with it. The row is OPEN again and the
             janitor's inactivity rule reads that column, so leaving it at the
             last `sign` would hand a session that was alive one second ago an
             activity stamp that may already be hours old — a multi-hour upload
             signs every part up front and then does not call `sign` again, so
             the stamp at this point is routinely from the start of the upload.
             The sweep would take the row out from under the client's retry.
             The age backstop is deliberately NOT moved: it is anchored on
             createdAt precisely so that it cannot be renewed. */
          await prisma.multipartSession
            .updateMany({
              where: { uploadId: session.uploadId, state: "COMPLETED" },
              data: { state: "OPEN", closedAt: null, lastActivityAt: new Date() }
            })
            .catch(() => {});
        }

        throw error;
      }

      return Response.json({ fileUrl: `${profile.publicBaseUrl}/${session.key}` });
    }

    /* Discards the parts of an upload that never finished. Nothing that was
       ever a complete object is touched. Without this, abandoned parts sit in
       the bucket being billed. */
    case "abort": {
      const opened = await openSession(body, uploader);
      if ("error" in opened) return opened.error;
      const { session, profile } = opened;

      /* The refund is the transition, not the storage call. AbortMultipartUpload
         is idempotent — it says "fine" however many times it is called, and says
         it just as cheerfully after a successful complete — so it can never be
         the thing that authorises giving bytes back. Exactly one caller moves
         this row out of OPEN, so exactly one refund is possible. */
      /* Claim and refund in one transaction. As two statements with a storage
         round trip between them, a crash or a timeout after the claim left the
         row ABORTED with the bytes still charged — and nothing revisits a
         settled row, so those bytes were gone for good. Committing both together
         means the refund exists if and only if the transition does. */
      const claimed = await prisma.$transaction(async (tx) => {
        const won = await tx.multipartSession.updateMany({
          where: { uploadId: session.uploadId, userId: uploader.id, state: "OPEN" },
          data: { state: "ABORTED", closedAt: new Date() }
        });
        if (won.count !== 1) return false;

        const refund = Number(session.bytesCharged);
        if (refund > 0) await releaseQuota(uploader.id, refund, tx);
        return true;
      });

      if (claimed) {
        /* Outside the transaction, and best effort: it is a network call that
           must not hold a database transaction open, and its answer authorises
           nothing. The row is already settled and the janitor does not revisit
           it, so a leftover part costs storage, not quota. */
        await profile.client
          .send(
            new AbortMultipartUploadCommand({
              Bucket: profile.bucket,
              Key: session.key,
              UploadId: session.uploadId
            })
          )
          .catch(() => {});
      }

      // A second abort, or an abort after complete, is a no-op rather than an
      // error: the client's cleanup path should stay quiet either way.
      return Response.json({ ok: true });
    }

    default:
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
}
