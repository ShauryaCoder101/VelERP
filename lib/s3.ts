import { S3Client } from "@aws-sdk/client-s3";

type S3Config = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
};

export function getS3Config(): S3Config | null {
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const bucket = process.env.S3_BUCKET;
  if (!region || !accessKeyId || !secretAccessKey || !bucket) return null;
  const base = process.env.S3_PUBLIC_BASE_URL;
  const publicBaseUrl = base ? base.replace(/\/$/, "") : `https://${bucket}.s3.${region}.amazonaws.com`;
  return { region, accessKeyId, secretAccessKey, bucket, publicBaseUrl };
}

export function createS3Client(config: S3Config) {
  return new S3Client({
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
  });
}
