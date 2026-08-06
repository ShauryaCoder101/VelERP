/*
 * Generate thumbnails and previews for media uploaded before the browser
 * started producing them.
 *
 * Without this, older galleries fall back to serving full-resolution originals
 * — which is the exact egress cost the derivatives exist to avoid. Run once
 * after deploying; new uploads make their own on the way up.
 *
 * Works across both stores: each file is read from whichever bucket its URL
 * points at, and the derivatives are written back beside it.
 *
 *   npx tsx scripts/backfill-derivatives.mts            # dry run
 *   npx tsx scripts/backfill-derivatives.mts --commit
 *
 * Videos are skipped — a poster frame needs ffmpeg, and the browser already
 * makes one for anything uploaded from now on.
 */

import fs from "fs";
import path from "path";

// Standalone scripts do not get Next's env loading.
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (!line.includes("=") || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const sharp = (await import("sharp")).default;
const { PrismaClient } = await import("@prisma/client");
const { resolveForUrl } = await import("../lib/storage.js");
const { GetObjectCommand, PutObjectCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
const { derivativeKeyFor } = await import("../lib/uploadKey.js");

const COMMIT = process.argv.includes("--commit");
const THUMB_EDGE = 400;
const PREVIEW_EDGE = 1600;

const prisma = new PrismaClient();

const streamToBuffer = async (body: any): Promise<Buffer> => {
  if (typeof body?.transformToByteArray === "function") return Buffer.from(await body.transformToByteArray());
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const main = async () => {
  console.log(COMMIT ? "MODE: commit\n" : "MODE: dry run (pass --commit to write)\n");

  const uploads = await prisma.upload.findMany({
    select: { id: true, fileUrl: true, fileType: true },
    orderBy: { createdAt: "desc" }
  });

  let made = 0, skipped = 0, failed = 0, videos = 0;

  for (const u of uploads) {
    const found = resolveForUrl(u.fileUrl);
    if (!found) { skipped++; continue; }

    if (!u.fileType.startsWith("image/")) { videos++; continue; }

    const { profile, key } = found;
    const thumbKey = derivativeKeyFor(key, "thumb");

    // Already has derivatives? Leave it alone.
    try {
      await profile.client.send(new HeadObjectCommand({ Bucket: profile.bucket, Key: thumbKey }));
      skipped++;
      continue;
    } catch {
      /* not there — generate it */
    }

    const name = decodeURIComponent(key.split("/").pop() ?? key);
    if (!COMMIT) {
      console.log(`would generate  ${profile.id}  ${name}`);
      made++;
      continue;
    }

    try {
      const obj = await profile.client.send(new GetObjectCommand({ Bucket: profile.bucket, Key: key }));
      const original = await streamToBuffer(obj.Body);

      for (const [kind, edge, quality] of [["thumb", THUMB_EDGE, 70], ["preview", PREVIEW_EDGE, 82]] as const) {
        const body = await sharp(original)
          .rotate() // honour EXIF orientation
          .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer();
        await profile.client.send(new PutObjectCommand({
          Bucket: profile.bucket,
          Key: derivativeKeyFor(key, kind),
          Body: body,
          ContentType: "image/jpeg"
        }));
      }
      console.log(`generated  ${profile.id}  ${name}`);
      made++;
    } catch (error: any) {
      console.log(`FAILED     ${name} — ${error?.message ?? error}`);
      failed++;
    }
  }

  console.log(`\n${made} generated, ${skipped} already had them, ${videos} videos skipped, ${failed} failed`);
  if (videos > 0) console.log("Videos need a poster frame from ffmpeg; new uploads get one from the browser.");
};

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
