/**
 * Default receipt storage: bytes live in Postgres (receipt_files), so a
 * deployment needs nothing but its database and uploads survive restarts.
 */

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/index.js';
import { receiptFiles } from '../../src/db/schema.js';
import { deleteReceipts, openReceipt, storageBackend, uploadReceipt } from '../../src/storage/index.js';
import { hasTestDb, PNG } from '../helpers/fixtures.js';

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe.skipIf(!hasTestDb)('receipt storage in Postgres', () => {
  it('is the default backend in tests', () => expect(storageBackend()).toBe('database'));

  it('stores, streams back byte-for-byte, and deletes', async () => {
    const { name, url } = await uploadReceipt(PNG);
    expect(url).toBe(`/receipts/${name}`);

    const [row] = await db.select().from(receiptFiles).where(eq(receiptFiles.name, name));
    expect(row).toMatchObject({ contentType: 'image/png', sizeBytes: PNG.length });

    const file = await openReceipt(name);
    expect(file).toMatchObject({ contentType: 'image/png', size: PNG.length });
    expect(await readAll(file!.body)).toEqual(PNG);

    await deleteReceipts([name, '../not-a-receipt']);
    expect(await openReceipt(name)).toBeNull();
  });

  it('handles a large (close to 10 MB) PDF', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(9 * 1024 * 1024, 0x20)]);
    const { name } = await uploadReceipt(big);
    const file = await openReceipt(name);
    expect((await readAll(file!.body)).equals(big)).toBe(true);
    await deleteReceipts([name]);
  });
});
