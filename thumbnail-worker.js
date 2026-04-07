#!/usr/bin/env node
// thumbnail-worker.js
//
// Periodically checks your R2 bucket for images without a corresponding
// thumbnail and generates + uploads them using sharp.
//
// Setup:
//   npm install @aws-sdk/client-s3 sharp dotenv
//
// .env:
//   R2_ACCOUNT_ID=your_cloudflare_account_id
//   R2_ACCESS_KEY_ID=your_r2_access_key
//   R2_SECRET_ACCESS_KEY=your_r2_secret_key
//   R2_BUCKET_NAME=your_bucket_name
//   R2_PUBLIC_URL=https://assets.owencamber.co.uk
//
// Run once:
//   node thumbnail-worker.js
//
// Run as a cron (every 15 minutes):
//   */15 * * * * /usr/bin/node /path/to/thumbnail-worker.js >> /var/log/thumbnails.log 2>&1

import "dotenv/config";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

// ─── Config ───────────────────────────────────────────────────────────────────
const THUMBNAIL_WIDTH = 600;
const THUMBNAIL_QUALITY = 70;
const PHOTOS_PREFIX = "photos/";
const THUMBNAILS_PREFIX = "thumbnails/";
const CONCURRENT_LIMIT = 5; // process N images at a time

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Check if a key exists in the bucket
async function keyExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

// Stream an S3 object into a Buffer
async function getObjectBuffer(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// List all objects under a given prefix
async function listAllObjects(prefix = "") {
  const objects = [];
  let continuationToken;

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    if (res.Contents) objects.push(...res.Contents);
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  return objects;
}

// Process N items concurrently
async function withConcurrency(items, limit, fn) {
  const results = [];
  let i = 0;

  async function runNext() {
    if (i >= items.length) return;
    const item = items[i++];
    results.push(await fn(item));
    await runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

async function generateThumbnail(key) {
  const relativePath = key.slice(PHOTOS_PREFIX.length);
  const thumbnailKey = `${THUMBNAILS_PREFIX}${relativePath}`;

  // Check if thumbnail already exists
  if (await keyExists(thumbnailKey)) {
    return { key, status: "skipped" };
  }

  console.log(`  Generating thumbnail for: ${key}`);

  try {
    // Download original
    const originalBuffer = await getObjectBuffer(key);

    // Resize with sharp
    const thumbnailBuffer = await sharp(originalBuffer)
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .webp({
        quality: THUMBNAIL_QUALITY,
        effort: 6
      })
      .toBuffer();

    // Upload thumbnail
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: thumbnailKey,
        Body: thumbnailBuffer,
        ContentType: "image/webp",
        Metadata: {
          "source-key": key,
          "generated-at": new Date().toISOString(),
        },
      })
    );

    const savedPercent = Math.round(
      (1 - thumbnailBuffer.length / originalBuffer.length) * 100
    );
    console.log(
      `  ✓ ${key} → ${thumbnailKey} (${(thumbnailBuffer.length / 1024).toFixed(1)} KB, ${savedPercent}% smaller)`
    );

    return { key, thumbnailKey, status: "created" };
  } catch (err) {
    console.error(`  ✗ Failed: ${key} — ${err.message}`);
    return { key, status: "error", error: err.message };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`[${new Date().toISOString()}] Starting thumbnail worker...`);

  // List all objects, excluding anything already in thumbnails/
  const allObjects = await listAllObjects();
  const imageKeys = allObjects
    .map((o) => o.Key)
    .filter(
      (key) =>
        key.startsWith(PHOTOS_PREFIX) &&
        /\.(jpe?g|png|gif|webp|avif|tiff?)$/i.test(key)
    );

  if (imageKeys.length === 0) {
    console.log("No images found. Exiting.");
    return;
  }

  console.log(`Found ${imageKeys.length} image(s). Checking for missing thumbnails...`);

  const results = await withConcurrency(imageKeys, CONCURRENT_LIMIT, generateThumbnail);

  const created = results.filter((r) => r.status === "created").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errors = results.filter((r) => r.status === "error").length;

  console.log(`\nDone. Created: ${created} | Skipped: ${skipped} | Errors: ${errors}`);
  console.log(`[${new Date().toISOString()}] Worker finished.`);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});