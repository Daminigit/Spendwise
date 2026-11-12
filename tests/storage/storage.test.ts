import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  detectFileType,
  isValidReceiptName,
  openReceipt,
  uploadReceipt,
  UnsupportedFileError,
  storageBackend,
} from '../../src/storage/index.js';

const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(32)]);
const JPG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const PNG = pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const WEBP = pad(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'binary'));
const PDF = pad(Buffer.from('%PDF-1.7\n'));
const HEIC = pad(Buffer.from('\0\0\0\x18ftypheic', 'binary'));

describe('detectFileType', () => {
  it.each([
    ['jpg', JPG, '.jpg'],
    ['png', PNG, '.png'],
    ['webp', WEBP, '.webp'],
    ['pdf', PDF, '.pdf'],
    ['heic', HEIC, '.heic'],
  ])('detects %s from magic bytes', (_n, buf, ext) => expect(detectFileType(buf)?.ext).toBe(ext));

  it('rejects HTML pretending to be an image', () =>
    expect(detectFileType(pad(Buffer.from('<html><script>alert(1)</script>')))).toBeNull());
  it('rejects SVG', () => expect(detectFileType(pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')))).toBeNull());
  it('rejects tiny buffers', () => expect(detectFileType(Buffer.from([0xff, 0xd8]))).toBeNull());
});

describe('isValidReceiptName', () => {
  it('accepts uuid + known extension', () =>
    expect(isValidReceiptName('c52837f2-4175-4540-acf4-f85448fc6363.png')).toBe(true));
  it.each(['../etc/passwd', 'c52837f2-4175-4540-acf4-f85448fc6363.html', 'x.png', 'C52837F2-4175-4540-ACF4-F85448FC6363.png', ''])(
    'rejects %j',
    (n) => expect(isValidReceiptName(n)).toBe(false),
  );
});

describe('local disk storage', () => {
  let dir: string;
  const prev = { endpoint: process.env.S3_ENDPOINT, uploads: process.env.UPLOADS_DIR, backend: process.env.RECEIPT_STORAGE };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'spendwise-uploads-'));
    delete process.env.S3_ENDPOINT;
    process.env.RECEIPT_STORAGE = 'disk';
    process.env.UPLOADS_DIR = dir;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    if (prev.endpoint !== undefined) process.env.S3_ENDPOINT = prev.endpoint;
    if (prev.uploads !== undefined) process.env.UPLOADS_DIR = prev.uploads;
    else delete process.env.UPLOADS_DIR;
    if (prev.backend !== undefined) process.env.RECEIPT_STORAGE = prev.backend;
    else delete process.env.RECEIPT_STORAGE;
  });

  it('stores a receipt and returns an app path, not a public URL', async () => {
    const r = await uploadReceipt(PNG);
    expect(r.url).toMatch(/^\/receipts\/[0-9a-f-]{36}\.png$/);
    expect(await readFile(path.join(dir, r.name))).toEqual(PNG);
  });

  it('opens a stored receipt with the right content type', async () => {
    const r = await uploadReceipt(PDF);
    const f = await openReceipt(r.name);
    expect(f?.contentType).toBe('application/pdf');
    expect(f?.size).toBe(PDF.length);
    f?.body.destroy();
  });

  it('returns null for a missing or malformed name', async () => {
    expect(await openReceipt('00000000-0000-0000-0000-000000000000.png')).toBeNull();
    expect(await openReceipt('../../package.json')).toBeNull();
  });

  it('refuses unsupported bytes', async () => {
    await expect(uploadReceipt(pad(Buffer.from('hello world')))).rejects.toBeInstanceOf(UnsupportedFileError);
  });
});

describe('storageBackend', () => {
  const saved = { s3: process.env.S3_ENDPOINT, mode: process.env.RECEIPT_STORAGE };
  afterAll(() => {
    if (saved.s3 === undefined) delete process.env.S3_ENDPOINT;
    else process.env.S3_ENDPOINT = saved.s3;
    if (saved.mode === undefined) delete process.env.RECEIPT_STORAGE;
    else process.env.RECEIPT_STORAGE = saved.mode;
  });

  it('defaults to the database', () => {
    delete process.env.S3_ENDPOINT;
    delete process.env.RECEIPT_STORAGE;
    expect(storageBackend()).toBe('database');
  });
  it('uses disk when asked', () => {
    process.env.RECEIPT_STORAGE = 'disk';
    expect(storageBackend()).toBe('disk');
  });
  it('prefers S3 whenever an endpoint is configured', () => {
    process.env.S3_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
    expect(storageBackend()).toBe('s3');
    delete process.env.S3_ENDPOINT;
  });
  it('rejects an unknown mode with a clear message', () => {
    process.env.RECEIPT_STORAGE = 'cloud';
    expect(() => storageBackend()).toThrow(/RECEIPT_STORAGE must be "database" or "disk"/);
  });
});
