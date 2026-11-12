/**
 * src/storage/index.ts
 *
 * Receipt file storage. Receipts contain personal data, so they are never
 * served from a public URL: the stored `receipt_url` is an app path
 * (`/receipts/<uuid>.<ext>`) and the app checks claim access before streaming
 * the file (see src/web/routes/receipts.ts).
 *
 * Backends (first match wins):
 * - S3_ENDPOINT set          → private S3-compatible bucket (Cloudflare R2), `receipts/` prefix
 * - RECEIPT_STORAGE=disk     → ./uploads/ (or UPLOADS_DIR) on local disk
 * - otherwise (default)      → the `receipt_files` table in Postgres, so a deployment
 *                              needs only its database and survives restarts
 */

import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, stat, writeFile } from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { receiptFiles } from '../db/schema.js';

// ── File type detection (magic bytes — never trust the client's mime type) ───

export interface FileType {
  ext: '.jpg' | '.png' | '.webp' | '.heic' | '.pdf';
  mime: string;
}

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export function detectFileType(buf: Buffer): FileType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', mime: 'image/png' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  if (buf.toString('ascii', 0, 5) === '%PDF-') return { ext: '.pdf', mime: 'application/pdf' };
  // ISO-BMFF: "ftyp" box at offset 4 with a HEIF brand (iPhone photos)
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(buf.toString('ascii', 8, 12))) {
    return { ext: '.heic', mime: 'image/heic' };
  }
  return null;
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
};

/** Stored names are always `<uuid>.<ext>`; anything else is rejected (no path tricks). */
const NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|heic|pdf)$/;

export function isValidReceiptName(name: string): boolean {
  return NAME_RE.test(name);
}

export const RECEIPT_URL_PREFIX = '/receipts/';

export function receiptUrlFor(name: string): string {
  return `${RECEIPT_URL_PREFIX}${name}`;
}

// ── Backend selection ─────────────────────────────────────────────────────────

export type StorageBackend = 's3' | 'disk' | 'database';

export function storageBackend(): StorageBackend {
  if (process.env.S3_ENDPOINT) return 's3';
  const v = (process.env.RECEIPT_STORAGE || 'database').trim().toLowerCase();
  if (v === 'disk') return 'disk';
  if (v === 'database' || v === 'db') return 'database';
  throw new Error(`RECEIPT_STORAGE must be "database" or "disk" (got "${v}").`);
}

/** Fail fast at startup if storage is misconfigured. */
export function assertStorageConfig(): void {
  if (storageBackend() !== 's3') return;
  const missing = ['S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`S3_ENDPOINT is set but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`);
  }
}

function localDir(): string {
  return path.resolve(process.env.UPLOADS_DIR ?? 'uploads');
}

let s3Client: S3Client | undefined;
async function s3(): Promise<S3Client> {
  if (!s3Client) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY!,
        secretAccessKey: process.env.S3_SECRET_KEY!,
      },
    });
  }
  return s3Client;
}

const s3Key = (name: string) => `receipts/${name}`;

// ── Public API ────────────────────────────────────────────────────────────────

export interface UploadResult {
  /** App path to store in expenses.receipt_url, e.g. /receipts/<uuid>.jpg */
  url: string;
  name: string;
  type: FileType;
}

export class UnsupportedFileError extends Error {}

/** Store a receipt. Throws UnsupportedFileError if the bytes aren't JPG/PNG/WebP/HEIC/PDF. */
export async function uploadReceipt(buffer: Buffer): Promise<UploadResult> {
  const type = detectFileType(buffer);
  if (!type) throw new UnsupportedFileError('Receipts must be a JPG, PNG, WebP, HEIC or PDF file.');
  if (buffer.length > MAX_RECEIPT_BYTES) throw new UnsupportedFileError('File is too large (max 10 MB).');

  const name = `${randomUUID()}${type.ext}`;

  const backend = storageBackend();
  if (backend === 'database') {
    await db.insert(receiptFiles).values({ name, contentType: type.mime, sizeBytes: buffer.length, data: buffer });
  } else if (backend === 's3') {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await s3()).send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET!,
        Key: s3Key(name),
        Body: buffer,
        ContentType: type.mime,
      }),
    );
  } else {
    const dir = localDir();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), buffer, { flag: 'wx' });
  }

  return { url: receiptUrlFor(name), name, type };
}

export interface ReceiptFile {
  body: Readable;
  contentType: string;
  size?: number;
}

/** Open a stored receipt for streaming, or null if it doesn't exist. */
export async function openReceipt(name: string): Promise<ReceiptFile | null> {
  if (!isValidReceiptName(name)) return null;
  const contentType = MIME_BY_EXT[path.extname(name)];

  const backend = storageBackend();
  if (backend === 'database') {
    const [row] = await db.select().from(receiptFiles).where(eq(receiptFiles.name, name));
    if (!row) return null;
    return { body: Readable.from([row.data]), contentType: row.contentType, size: row.sizeBytes };
  }

  if (backend === 's3') {
    const { GetObjectCommand, NoSuchKey } = await import('@aws-sdk/client-s3');
    try {
      const out = await (await s3()).send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: s3Key(name) }));
      if (!out.Body) return null;
      return { body: out.Body as Readable, contentType, size: out.ContentLength };
    } catch (err) {
      if (err instanceof NoSuchKey || (err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }

  const file = path.join(localDir(), name);
  try {
    const s = await stat(file);
    return { body: createReadStream(file), contentType, size: s.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Delete stored receipts by name (used when the demo seed is reset).
 * Only the database backend is cleaned up; disk/S3 files are left as orphans.
 */
export async function deleteReceipts(names: string[]): Promise<void> {
  const valid = names.filter(isValidReceiptName);
  if (valid.length === 0 || storageBackend() !== 'database') return;
  await db.delete(receiptFiles).where(inArray(receiptFiles.name, valid));
}
