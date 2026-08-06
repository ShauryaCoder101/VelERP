import { S3Client } from "@aws-sdk/client-s3";

/* Storage is split by what the bytes are for, because the two kinds have
   opposite cost profiles.

     media     bulk event photos and video. Huge, and clients download them,
               so egress dominates -> Cloudflare R2 (zero egress).
     document  bills, cost sheets, avatars. Tiny, rarely read -> stays on S3.
     archive   originals older than the hot window, moved by rclone into
               S3 Glacier Deep Archive. Same key, different bucket.

   R2 speaks the S3 API, so one client type covers all three. If the R2
   variables are absent every profile falls back to S3 and nothing changes —
   which is what makes this safe to deploy before the credentials exist. */

export type ProfileName = "media" | "document" | "archive";

export type StorageProfile = {
  id: "s3" | "r2" | "archive";
  client: S3Client;
  bucket: string;
  /** canonical prefix stored in Upload.fileUrl — also how reads are routed */
  publicBaseUrl: string;
};

const cache = new Map<string, StorageProfile | null>();

const s3Profile = (): StorageProfile | null => {
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const bucket = process.env.S3_BUCKET;
  if (!region || !accessKeyId || !secretAccessKey || !bucket) return null;

  const base = process.env.S3_PUBLIC_BASE_URL;
  return {
    id: "s3",
    client: new S3Client({ region, credentials: { accessKeyId, secretAccessKey } }),
    bucket,
    publicBaseUrl: base ? base.replace(/\/$/, "") : `https://${bucket}.s3.${region}.amazonaws.com`
  };
};

const r2Profile = (): StorageProfile | null => {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;

  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const base = process.env.R2_PUBLIC_BASE_URL;
  return {
    id: "r2",
    client: new S3Client({
      region: "auto",
      endpoint,
      // Path style keeps the stored URL predictable: <endpoint>/<bucket>/<key>
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey }
    }),
    bucket,
    publicBaseUrl: base ? base.replace(/\/$/, "") : `${endpoint}/${bucket}`
  };
};

/* Deep Archive lives in its own S3 bucket. rclone preserves the key exactly,
   so a cold object is found at the same key in this bucket. */
const archiveProfile = (): StorageProfile | null => {
  const bucket = process.env.S3_ARCHIVE_BUCKET;
  const s3 = s3Profile();
  if (!bucket || !s3) return null;
  const region = process.env.S3_REGION;
  return {
    id: "archive",
    client: s3.client,
    bucket,
    publicBaseUrl: `https://${bucket}.s3.${region}.amazonaws.com`
  };
};

const memo = (key: string, build: () => StorageProfile | null) => {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key) ?? null;
};

export const getProfile = (name: ProfileName): StorageProfile | null => {
  if (name === "archive") return memo("archive", archiveProfile);
  if (name === "media") return memo("r2", r2Profile) ?? memo("s3", s3Profile);
  return memo("s3", s3Profile);
};

/* Reads are routed by the stored URL, not by configuration. That is what lets
   old S3 objects and new R2 objects coexist with no migration and no backfill. */
export const resolveForUrl = (fileUrl: string): { profile: StorageProfile; key: string } | null => {
  const candidates = [memo("r2", r2Profile), memo("s3", s3Profile), memo("archive", archiveProfile)];
  for (const profile of candidates) {
    if (!profile) continue;
    const prefix = `${profile.publicBaseUrl}/`;
    if (fileUrl.startsWith(prefix)) {
      return { profile, key: decodeURIComponent(fileUrl.slice(prefix.length)) };
    }
  }
  return null;
};

export const isR2Enabled = () => memo("r2", r2Profile) !== null;
export const isArchiveEnabled = () => memo("archive", archiveProfile) !== null;
