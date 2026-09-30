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
import { getProfile } from "../../../../lib/storage";
import { getUploader, type Uploader } from "../../../../lib/rbac-server";
import { buildUploadKey } from "../../../../lib/uploadKey";
import { partSizeFor } from "../../../../lib/upload-client";
import { allocateQuota, hasEventAccess, releaseQuota } from "../../../../lib/photographers";
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

const PART_EXPIRY = 6 * 60 * 60; // long uploads must outlive their signatures
const TICKET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

/* sign / complete / abort all start the same way: a valid ticket for this user,
   and the session row it names. The row, not the ticket, is the source of
   truth — it is what says whether this upload is still live. */
const openSession = async (body: any, uploader: Uploader) => {
  const ticket = verifyTicket(body.token);
  if (!ticket) {
    return { error: Response.json({ error: "This upload has expired — please start it again" }, { status: 403 }) } as const;
  }
  if (ticket.i !== uploader.id) {
    return { error: Response.json({ error: "This upload belongs to someone else" }, { status: 403 }) } as const;
  }

  const session = await prisma.multipartSession.findUnique({ where: { uploadId: ticket.u } });
  /* Same answer for "no such row" and "someone else's row": a caller holding a
     forged-but-unverifiable id learns nothing about what exists. */
  if (!session || session.userId !== uploader.id) {
    return { error: Response.json({ error: "This upload is no longer available" }, { status: 409 }) } as const;
  }

  const profile = profileFor(session.purpose);
  if (!profile) return { error: Response.json({ error: "Storage is not configured" }, { status: 500 }) } as const;
  return { session, profile } as const;
};

export async function POST(request: Request) {
  const uploader = await getUploader(request);
  if (!uploader) return new Response("Forbidden", { status: 403 });

  const body = await request.json();

  switch (body.action) {
    /* Reserve the key, charge the quota, and open the upload. */
    case "create": {
      const purpose: "media" | "document" = body.purpose === "media" ? "media" : "document";
      const eventId = String(body.eventId ?? "general");

      const fileSize = Number(body.fileSize);
      if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
        return Response.json({ error: "fileSize is required" }, { status: 400 });
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
        key = buildUploadKey(eventId, body.relativePath ?? "", body.fileName ?? "upload");
      }

      let charged = 0;
      if (uploader.isPhotographer) {
        const quota = await allocateQuota(uploader.id, fileSize);
        if (!quota.ok) {
          return Response.json(
            { error: "Upload limit reached", usedBytes: quota.usedBytes, quotaBytes: quota.quotaBytes },
            { status: 403 }
          );
        }
        charged = fileSize;
      }

      const partSize = partSizeFor(fileSize);

      let uploadId: string;
      try {
        const created = await profile.client.send(
          new CreateMultipartUploadCommand({
            Bucket: profile.bucket,
            Key: key,
            ContentType: body.fileType || "application/octet-stream"
          })
        );
        if (!created.UploadId) throw new Error("storage returned no upload id");
        uploadId = created.UploadId;
      } catch (error) {
        // Nothing was opened, so nothing will ever be aborted to refund it.
        if (charged > 0) await releaseQuota(uploader.id, charged).catch(() => {});
        throw error;
      }

      /* Without this row the upload is unusable: sign, complete and abort all
         refuse an upload they cannot find, and the janitor would never see it
         to reclaim the bytes. So a failed insert has to undo both sides. */
      try {
        await prisma.multipartSession.create({
          data: {
            uploadId,
            userId: uploader.id,
            key,
            eventId,
            purpose,
            fileSize: BigInt(fileSize),
            partSize: BigInt(partSize),
            bytesCharged: BigInt(charged)
          }
        });
      } catch (error) {
        await profile.client
          .send(new AbortMultipartUploadCommand({ Bucket: profile.bucket, Key: key, UploadId: uploadId }))
          .catch(() => {});
        if (charged > 0) await releaseQuota(uploader.id, charged).catch(() => {});
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
         that moves OPEN -> COMPLETED is allowed to. */
      const claimed = await prisma.multipartSession.updateMany({
        where: { uploadId: session.uploadId, userId: uploader.id, state: "OPEN" },
        data: { state: "COMPLETED", closedAt: new Date() }
      });
      if (claimed.count !== 1) {
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
             left to discard them. */
          await prisma.multipartSession
            .updateMany({
              where: { uploadId: session.uploadId, state: "COMPLETED" },
              data: { state: "OPEN", closedAt: null }
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
