import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

let s3Client = null;

function sanitizeSegment(input = "") {
  return String(input || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function getConfig() {
  return {
    region: String(process.env.AWS_REGION || "us-east-1").trim(),
    bucket: String(process.env.S3_LAS_BUCKET || "").trim(),
    prefix: String(process.env.S3_LAS_PREFIX || "las-files").trim(),
  };
}

function getClient() {
  if (s3Client) return s3Client;
  const { region } = getConfig();
  s3Client = new S3Client({ region });
  return s3Client;
}

export function isLasS3Enabled() {
  const { bucket } = getConfig();
  return Boolean(bucket);
}

export async function uploadLasTextToS3({ wellId, originalName, text }) {
  const { bucket, region, prefix } = getConfig();
  if (!bucket) {
    throw new Error("S3_LAS_BUCKET is not configured");
  }

  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");

  const safeWellId = sanitizeSegment(wellId || "well");
  const safeName = sanitizeSegment(originalName || "upload.las") || "upload.las";
  const key = `${prefix}/${yyyy}/${mm}/${dd}/${safeWellId}/${Date.now()}-${randomUUID()}-${safeName}`;

  const put = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: Buffer.from(String(text || ""), "utf8"),
    ContentType: "text/plain; charset=utf-8",
  });
  const out = await getClient().send(put);

  return {
    provider: "s3",
    region,
    bucket,
    key,
    eTag: out?.ETag || null,
    uploadedAt: now.toISOString(),
  };
}
