/**
 * src/storage/index.ts
 *
 * Receipt image storage.
 * - Dev  (S3_ENDPOINT not set): saves to ./uploads/ on local disk.
 * - Prod (S3_ENDPOINT set):     uploads to Cloudflare R2 (or any S3-compatible).
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

export interface UploadResult {
  url: string;
}

function localUploadsDir(): string {
  const dir = path.resolve('uploads');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Upload a receipt buffer and return its public URL. */
export async function uploadReceipt(
  buffer: Buffer,
  originalName: string,
): Promise<UploadResult> {
  const ext = path.extname(originalName).toLowerCase() || '.jpg';
  const filename = `${randomUUID()}${ext}`;

  if (!process.env.S3_ENDPOINT) {
    // Local dev — write to ./uploads/
    const dir = localUploadsDir();
    writeFileSync(path.join(dir, filename), buffer);
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    return { url: `${appUrl}/uploads/${filename}` };
  }

  // Production — S3-compatible (Cloudflare R2)
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: process.env.S3_REGION ?? 'auto',
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
  });

  const bucket = process.env.S3_BUCKET!;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `receipts/${filename}`,
      Body: buffer,
      ContentType: mimeType(ext),
    }),
  );

  // Return public CDN URL (R2 custom domain or default)
  const endpoint = process.env.S3_ENDPOINT!.replace(/\/$/, '');
  return { url: `${endpoint}/${bucket}/receipts/${filename}` };
}

function mimeType(ext: string): string {
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.pdf': 'application/pdf',
    '.webp': 'image/webp',
  };
  return map[ext] ?? 'application/octet-stream';
}

