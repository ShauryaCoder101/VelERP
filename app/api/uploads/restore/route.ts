import { RestoreObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "../../../../lib/db";
import { getProfile, resolveForUrl } from "../../../../lib/storage";
import { isArchived } from "../../../../lib/archive";
import { getRequestUser } from "../../../../lib/rbac-server";

/* Originals older than the hot window live in Glacier Deep Archive, which
   cannot be read directly — the object has to be thawed first. Standard is
   ~12 hours, Bulk ~48 and roughly eight times cheaper. Once thawed the object
   stays readable for RESTORE_DAYS, after which it goes cold again.
   Restoring is a single API call, so it fits a serverless function fine. */

const RESTORE_DAYS = 7;

const locate = async (uploadId: string) => {
  const upload = await prisma.upload.findUnique({
    where: { id: uploadId },
    select: { fileUrl: true, createdAt: true }
  });
  if (!upload) return null;

  const found = resolveForUrl(upload.fileUrl);
  if (!found) return null;

  const archive = getProfile("archive");
  if (!archive) return null;

  return { key: found.key, archive, cold: isArchived(upload.createdAt) };
};

export async function POST(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const body = await request.json();
  const target = await locate(String(body.uploadId ?? ""));
  if (!target) {
    return Response.json({ error: "Archive storage is not configured, or that file is unknown." }, { status: 400 });
  }
  if (!target.cold) {
    return Response.json({ status: "available", message: "This file is still available for direct download." });
  }

  const tier = body.tier === "Bulk" ? "Bulk" : "Standard";

  try {
    await target.archive.client.send(
      new RestoreObjectCommand({
        Bucket: target.archive.bucket,
        Key: target.key,
        RestoreRequest: { Days: RESTORE_DAYS, GlacierJobParameters: { Tier: tier } }
      })
    );
    return Response.json({
      status: "requested",
      tier,
      message:
        tier === "Bulk"
          ? "Retrieval started. The original will be ready in about 48 hours."
          : "Retrieval started. The original will be ready in about 12 hours."
    });
  } catch (error: any) {
    // Asking twice is not an error worth showing as one.
    if (error?.name === "RestoreAlreadyInProgress") {
      return Response.json({ status: "in_progress", message: "Retrieval is already under way." });
    }
    return Response.json({ error: "Could not start retrieval. Try again shortly." }, { status: 502 });
  }
}

export async function GET(request: Request) {
  const { id: userId } = await getRequestUser(request);
  if (!userId) return new Response("Forbidden", { status: 403 });

  const uploadId = new URL(request.url).searchParams.get("uploadId") ?? "";
  const target = await locate(uploadId);
  if (!target) return Response.json({ error: "Unknown file." }, { status: 400 });
  if (!target.cold) return Response.json({ status: "available" });

  try {
    const head = await target.archive.client.send(
      new HeadObjectCommand({ Bucket: target.archive.bucket, Key: target.key })
    );
    // e.g. 'ongoing-request="false", expiry-date="Wed, 10 Sep 2026 00:00:00 GMT"'
    const restore = head.Restore ?? "";
    if (restore.includes('ongoing-request="true"')) return Response.json({ status: "in_progress" });
    if (restore.includes('ongoing-request="false"')) return Response.json({ status: "ready" });
    return Response.json({ status: "cold" });
  } catch {
    return Response.json({ status: "cold" });
  }
}
