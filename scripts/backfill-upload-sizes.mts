/*
 * Record the byte size of media uploaded before Upload.sizeBytes existed.
 *
 * New uploads store their size when they are registered. Older rows have null,
 * which leaves the share-link ZIP and the per-event storage figures guessing.
 * This asks storage how big each object actually is and writes that down.
 *
 * Read-only against storage: HeadObject only, nothing is written to or removed
 * from any bucket. The only writes are Upload.sizeBytes, and only with --commit.
 *
 *   npx tsx scripts/backfill-upload-sizes.mts            # dry run
 *   npx tsx scripts/backfill-upload-sizes.mts --commit
 *
 * Objects that have since been moved to Glacier Deep Archive still answer
 * HeadObject, so archived media is covered too.
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

const { PrismaClient } = await import("@prisma/client");
const { resolveForUrl } = await import("../lib/storage.js");
const { HeadObjectCommand } = await import("@aws-sdk/client-s3");

const COMMIT = process.argv.includes("--commit");

const prisma = new PrismaClient();

const main = async () => {
  console.log(COMMIT ? "MODE: commit\n" : "MODE: dry run (pass --commit to write)\n");

  const uploads = await prisma.upload.findMany({
    where: { sizeBytes: null },
    select: { id: true, fileUrl: true },
    orderBy: { createdAt: "desc" }
  });

  console.log(`${uploads.length} upload${uploads.length === 1 ? "" : "s"} with no size on record\n`);

  let sized = 0, unresolved = 0, missing = 0;
  let totalBytes = 0n;

  for (const u of uploads) {
    const found = resolveForUrl(u.fileUrl);
    if (!found) {
      console.log(`no bucket   ${u.fileUrl}`);
      unresolved++;
      continue;
    }

    const { profile, key } = found;
    const name = decodeURIComponent(key.split("/").pop() ?? key);

    let bytes: number | undefined;
    try {
      const head = await profile.client.send(new HeadObjectCommand({ Bucket: profile.bucket, Key: key }));
      bytes = head.ContentLength;
    } catch (error: any) {
      console.log(`not found   ${profile.id}  ${name} — ${error?.name ?? error}`);
      missing++;
      continue;
    }

    if (typeof bytes !== "number") {
      console.log(`no length   ${profile.id}  ${name}`);
      missing++;
      continue;
    }

    totalBytes += BigInt(bytes);
    sized++;

    if (!COMMIT) {
      console.log(`would set   ${profile.id}  ${name}  ${bytes}`);
      continue;
    }

    await prisma.upload.update({ where: { id: u.id }, data: { sizeBytes: BigInt(bytes) } });
    console.log(`set         ${profile.id}  ${name}  ${bytes}`);
  }

  const gb = Number(totalBytes) / 1e9;
  console.log(
    `\n${sized} sized (${gb.toFixed(1)} GB), ${unresolved} not in any known bucket, ${missing} missing from storage`
  );
  if (missing > 0) {
    console.log("Rows missing from storage point at objects that never finished uploading; they keep sizeBytes null.");
  }
};

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
