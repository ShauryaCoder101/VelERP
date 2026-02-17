import { S3Client } from "@aws-sdk/client-s3";

const region = process.env.S3_REGION;
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

if (!region || !accessKeyId || !secretAccessKey) {
  throw new Error("Missing S3 environment configuration");
}

export const s3Client = new S3Client({
  region,
  credentials: { accessKeyId, secretAccessKey }
});

export const getS3Bucket = () => {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("Missing S3_BUCKET");
  }
  return bucket;
};

export const getPublicBaseUrl = () => {
  const bucket = getS3Bucket();
  const base = process.env.S3_PUBLIC_BASE_URL;
  if (base) return base.replace(/\/$/, "");
  return `https://${bucket}.s3.${process.env.S3_REGION}.amazonaws.com`;
};
