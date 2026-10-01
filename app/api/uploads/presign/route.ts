import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getProfile } from "../../../../lib/storage";
import { folderPathRejection, getUploadActor, pathUnderRoot } from "../../../../lib/upload-links";
import { buildUploadKey, derivativeKeyFor, type Derivative } from "../../../../lib/uploadKey";
import { MULTIPART_THRESHOLD } from "../../../../lib/upload-client";
import {
  claimSweepSlot,
  hasEventAccess,
  PREVIEW_MAX_BYTES,
  THUMB_MAX_BYTES
} from "../../../../lib/photographers";
import {
  chargeWithLedger,
  refundCharges,
  sweepCharges,
  type Charge,
  type UnsettledTier
} from "../../../../lib/upload-charges";
import { signReservation } from "../../../../lib/uploadReservation";

/* A signed Content-Length is the whole enforcement mechanism.
 *
 * R2 rejects a PUT whose body is not exactly the length signed into the URL
 * (403). So the size a photographer declares here is the size they can actually
 * upload — which is what makes it safe to charge that size against their quota
 * before a single byte moves. Without the signed length the declaration would
 * be a suggestion. */

const MAX_URL_TTL = 60 * 60;

/* A presigned PUT can be replayed until it expires: inside the window a photographer
   could re-send a PUT and overwrite the photo they just uploaded (the single-PUT
   original, or a .derived thumb/preview slot). Storage-level conditional writes
   (If-None-Match) aren't available on the bucket yet, so for photographers — third
   parties — we shrink the window instead. The client presigns each file immediately
   before uploading that file's derivatives and original (tpp-login/upload uploadOne,
   one file at a time), so 15 minutes is ample for the upload while cutting the replay
   window; S3/R2 check expiry at request start, so a long upload that began in time
   still completes. Employees, who are staff, keep the full hour.

   SWEEP_AFTER_MINUTES in lib/upload-charges.ts is anchored on this number: the
   ledger sweep may only decide a charged object is absent once no URL that could
   still write it exists. Lengthen this and that must lengthen too. */
const PHOTOGRAPHER_URL_TTL = 15 * 60;

/* Whose limit was hit, in words the person reading them can act on.
 *
 * A 429 here is never "you are out of space" — the bytes are held by presigns
 * nobody spent and come back on their own once they age past
 * SWEEP_AFTER_MINUTES. What differs is who is holding them, and that decides
 * what the reader should do: stop uploading, chase the rest of their crew, or
 * simply wait. One message for all four tiers told a contributor to wait while
 * the thing to do was close the twenty tabs they had open. */
const UNSETTLED_MESSAGE: Record<UnsettledTier, string> = {
  contributor:
    "You have too many uploads still waiting to finish. Let the ones in progress complete, then try again.",
  link: "This link has too many uploads still in progress. Wait a few minutes for them to finish, or ask for a link of your own.",
  links:
    "This firm's upload links have too many uploads still in progress. Please try again in a few minutes.",
  main: "Too many of your uploads are still waiting to finish. Please try again in a few minutes."
};

const positiveSafeInt = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
};

export async function POST(request: Request) {
  /* An actor, not an uploader: the caller may be an employee, a firm's main
     login, or someone holding one of that firm's open upload links. A
     contributor's actor still carries the FIRM's id, so the quota, the grant and
     the reservation below all keep working on the firm exactly as before — what
     it adds is `uploadRoot`, the prefix every key it mints must sit under. */
  const uploader = await getUploadActor(request);
  if (!uploader) return new Response("Forbidden", { status: 403 });

  /* Parsed defensively: this now accepts link credentials, so a malformed or
     empty body arrives from callers with no session and must come back as a
     400 rather than an unhandled throw Next renders as a 500. */
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const purpose = body.purpose === "media" ? "media" : "document";
  const eventId = String(body.eventId ?? "general");

  /* A link authorises ONE event. The firm may hold several, so the actor's own
     grant check below would happily pass for a different one. */
  if (uploader.contributor && uploader.contributor.eventId !== eventId) {
    return Response.json({ error: "This link is for a different event" }, { status: 403 });
  }

  /* Photographers are third parties: media only, and only into an event an
     employee has explicitly handed them. */
  if (uploader.isPhotographer) {
    if (purpose !== "media") {
      return Response.json({ error: "You can only upload event media" }, { status: 403 });
    }
    if (!(await hasEventAccess(uploader.id, eventId))) {
      return Response.json({ error: "You don't have access to this event" }, { status: 403 });
    }
  }

  /* Bulk event media goes to R2 (zero egress); bills, cost sheets and avatars
     stay on S3. Callers that say nothing get the old behaviour. */
  const profile = getProfile(purpose);
  if (!profile) {
    return Response.json({ error: "Storage is not configured" }, { status: 500 });
  }

  const fileType = body.fileType || "application/octet-stream";

  /* fileSize is required of photographers and optional for employees, whose
     existing callers predate it. Absent, the original goes as a single PUT with
     no signed length — exactly today's behaviour. */
  let fileSize: number | null = null;
  if (body.fileSize !== undefined && body.fileSize !== null) {
    fileSize = positiveSafeInt(body.fileSize);
    if (fileSize === null) return Response.json({ error: "fileSize is not a valid size" }, { status: 400 });
  }
  if (uploader.isPhotographer && fileSize === null) {
    return Response.json({ error: "The file size is missing — please try again" }, { status: 400 });
  }

  /* Deduped: ["thumb","thumb"] would otherwise be charged twice for one slot. */
  const wanted: Derivative[] = ["thumb", "preview"].filter((kind) =>
    (Array.isArray(body.derivatives) ? body.derivatives : []).includes(kind)
  ) as Derivative[];
  const caps: Record<Derivative, number> = { thumb: THUMB_MAX_BYTES, preview: PREVIEW_MAX_BYTES };
  const derivativeSizes: Partial<Record<Derivative, number>> = {};
  for (const kind of wanted) {
    const raw = body.derivativeSizes?.[kind];
    if (raw === undefined || raw === null) {
      if (!uploader.isPhotographer) continue; // legacy employee caller: sign without a length
      return Response.json({ error: `The ${kind} size is missing — please try again` }, { status: 400 });
    }
    const size = positiveSafeInt(raw);
    if (size === null) return Response.json({ error: `The ${kind} size is not valid` }, { status: 400 });
    if (size > caps[kind]) {
      return Response.json({ error: `The ${kind} image is too large` }, { status: 400 });
    }
    derivativeSizes[kind] = size;
  }

  /* Anything over the threshold must go through /api/uploads/multipart, which
     allocates the original's bytes itself. Allocating them here as well would
     double-charge the photographer. */
  const multipart = fileSize !== null && fileSize > MULTIPART_THRESHOLD;

  /* relativePath is the folder portion only ("Day 1/Stage"), empty for loose
     files — and, for a photographer or a contributor, it is relative to THEIR
     root rather than to the event. The root is prepended here, by the server,
     from the actor: there is no value the client can send that escapes it, so
     "which folder" stays the client's business and "whose folder" never is.

     Settled before the quota is charged. The folder endpoints cap nesting at
     MAX_FOLDER_DEPTH and storage refuses a key over 1024 bytes, so a path that
     breaks either has to be refused here — charged first, it would be bytes
     taken for a PUT that storage was always going to reject, with nothing to
     give them back. */
  const fileName = String(body.fileName ?? "upload");
  const folder = pathUnderRoot(uploader.uploadRoot, String(body.relativePath ?? ""));
  const rejection = folderPathRejection(folder, eventId, fileName, {
    limitDepth: uploader.uploadRoot !== null
  });
  if (rejection) return Response.json({ error: rejection }, { status: 400 });

  const key = buildUploadKey(eventId, folder, fileName);

  let chargeIds: string[] = [];
  if (uploader.isPhotographer) {
    /* Every object charged below becomes an UploadCharge row, so a charge for a
       PUT that never happens can be found again and given back. See
       lib/upload-charges.ts for why that is not optional any more: presign is
       reachable with a forwarded link, and ~62k calls declaring 16MB each would
       pin a firm's entire terabyte with nothing in the bucket.

       Multipart originals are NOT charged here — /api/uploads/multipart charges
       them at create and refunds them on its own OPEN -> ABORTED transition. */
    const charges: Charge[] = [];
    if (!multipart && fileSize !== null) charges.push({ key, bytes: fileSize });
    for (const kind of wanted) {
      const bytes = derivativeSizes[kind];
      if (bytes !== undefined) charges.push({ key: derivativeKeyFor(key, kind), bytes });
    }

    /* Reclaim this firm's own abandoned charges before asking for room, so the
       uploader in front of us benefits from it immediately rather than waiting
       for tonight's cron. Never fatal: it sits on the critical path of every
       single file.

       It runs BEFORE the charge, and therefore before the request that is about
       to be 429'd, on purpose. Everything cheap has already refused above — the
       actor, the event, the grant, the sizes, the folder path — and what is left
       is the one refusal sweeping can prevent: the unsettled ceiling is a
       measure of abandoned charges, so the sweep is not work done alongside the
       decision, it is the thing that changes the decision. Running it after a
       429 would mean the first uploader back from a flood is refused for bytes
       we were about to reclaim anyway.

       What stops a flood from buying one sweep per request is the slot claim,
       not the ordering: claimSweepSlot moves PhotographerProfile.lastSweptAt in
       one conditional UPDATE, so at most one caller per firm per minute does
       the work and everyone else skips straight to the charge. The budget is 25
       rows — one wave of HEADs — because that cost is now paid once a minute
       rather than once a file. */
    if (await claimSweepSlot(uploader.id).catch(() => false)) {
      await sweepCharges({ userId: uploader.id, limit: 25 }).catch(() => {});
    }

    /* Charge and enforce the unsettled ceilings in one transaction. The
       ceilings live inside chargeWithLedger rather than in a check out here:
       the allocation's row lock is what serialises a firm's presigns, so a
       total read outside it is a snapshot every concurrent request shares, and
       they all pass it. See lib/upload-charges.ts. */
    const quota = await chargeWithLedger(
      {
        userId: uploader.id,
        eventId,
        contributorId: uploader.contributor?.id ?? null,
        linkId: uploader.contributor?.linkId ?? null
      },
      charges
    );
    if (!quota.ok && quota.reason === "unsettled") {
      /* A flood, not a full account: bytes are held by presigns nobody spent.
         They come back on their own once they age past SWEEP_AFTER_MINUTES, so
         this is a 429 rather than the 403 a real ceiling gets. The message says
         WHOSE limit it was, because that is what decides what to do about it. */
      return Response.json({ error: UNSETTLED_MESSAGE[quota.tier] }, { status: 429 });
    }
    if (!quota.ok) {
      return Response.json(
        { error: "Upload limit reached", usedBytes: quota.usedBytes, quotaBytes: quota.quotaBytes },
        { status: 403 }
      );
    }
    chargeIds = quota.chargeIds;
  }

  /* This key is the one the derivative slots below are signed against, and
     derivativeUrlFor() recovers them from the stored original's URL by applying
     the same pure function. So the original has to land on exactly this key —
     including when it is too big for a single PUT and goes to /api/uploads/
     multipart instead. That route used to call buildUploadKey again and get a
     different timestamp, which is why every file over 16MB has been showing a
     broken thumbnail.

     The reservation carries this key to the multipart route through the browser
     without letting the browser pick it: it is an HMAC over { key, eventId,
     userId, purpose }, so a caller can spend the key it was given and nothing
     else. Always issued, even for single-PUT uploads, so the client has one
     code path and a file that crosses the threshold mid-flight still works. */
  const reservation = signReservation({ key, eventId, userId: uploader.id, purpose });

  // Photographers get the short replay window; employees keep the full hour.
  const urlTtl = uploader.isPhotographer ? PHOTOGRAPHER_URL_TTL : MAX_URL_TTL;

  const sign = (objectKey: string, contentType: string, contentLength?: number) =>
    getSignedUrl(
      profile.client,
      new PutObjectCommand({
        Bucket: profile.bucket,
        Key: objectKey,
        ContentType: contentType,
        // Signed, so the caller cannot send more bytes than it declared.
        ...(contentLength === undefined ? {} : { ContentLength: contentLength })
      }),
      { expiresIn: urlTtl }
    );

  try {
    /* The browser also sends a thumbnail and a preview. Signing their slots in
       the same call keeps it to one round trip per file, which matters when a
       shoot is a few thousand of them. */
    const derivatives: Record<string, { uploadUrl: string; fileUrl: string }> = {};
    for (const kind of wanted) {
      const dKey = derivativeKeyFor(key, kind);
      derivatives[kind] = {
        uploadUrl: await sign(dKey, "image/jpeg", derivativeSizes[kind]),
        fileUrl: `${profile.publicBaseUrl}/${dKey}`
      };
    }

    if (multipart) {
      /* No original slot: the client opens a multipart upload, handing back the
         reservation so that upload lands on this key rather than a new one. */
      return Response.json({ key, reservation, derivatives, multipart: true, storage: profile.id });
    }

    return Response.json({
      uploadUrl: await sign(key, fileType, fileSize ?? undefined),
      fileUrl: `${profile.publicBaseUrl}/${key}`,
      key,
      reservation,
      derivatives,
      multipart: false,
      storage: profile.id
    });
  } catch (error) {
    /* The bytes were charged before signing; a failure here must not keep them.
       Refunded through the ledger rather than with a bare releaseQuota, so the
       refund rides on the same once-only claim a sweep would use — otherwise a
       signing failure and a sweep that reached the row first could each pay it. */
    await refundCharges(chargeIds).catch(() => {});
    throw error;
  }
}
