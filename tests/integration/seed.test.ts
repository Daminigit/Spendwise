/**
 * The demo seed: covers every claim status, is re-runnable with reset,
 * and the demo token works.
 */

import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/index.js';
import { claims, users } from '../../src/db/schema.js';
import { DEMO_EMAILS, receiptPdf, seedDemo } from '../../src/db/seed.js';
import { authenticateToken } from '../../src/domain/tokens.js';
import { getSpendReport } from '../../src/domain/reports.js';
import { hasTestDb } from '../helpers/fixtures.js';

describe('receiptPdf', () => {
  it('produces a PDF whose startxref points at the xref table', () => {
    const pdf = receiptPdf(['Cafe (Mumbai)', 'TOTAL: Rs 100.00']);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdf.toString('latin1');
    const offset = Number(text.slice(text.lastIndexOf('startxref') + 9).trim().split('\n')[0]);
    expect(text.slice(offset, offset + 4)).toBe('xref');
    expect(text).toContain('Cafe \\(Mumbai\\)');
  });
});

describe.skipIf(!hasTestDb)('seedDemo', () => {
  it('creates the demo org with claims in every status, and can be reset', async () => {
    const result = await seedDemo({ reset: true, verbose: false });
    expect(result).not.toBeNull();

    const statuses = await db
      .select({ status: claims.status, n: sql<number>`count(*)::int` })
      .from(claims)
      .where(eq(claims.orgId, result!.orgId))
      .groupBy(claims.status);
    expect(statuses.map((s) => s.status).sort()).toEqual(['approved', 'draft', 'paid', 'partially_approved', 'rejected', 'submitted']);

    const [{ sources }] = await db
      .select({ sources: sql<string[]>`array_agg(distinct ${claims.source})` })
      .from(claims)
      .where(eq(claims.orgId, result!.orgId));
    expect(sources.sort()).toEqual(['claude', 'web']);

    // ~3 months of history for the reports page
    const rows = await getSpendReport(result!.orgId, result!.userIds.admin, {
      from: new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
      groupBy: 'month',
    });
    expect(rows.length).toBeGreaterThanOrEqual(3);

    // The demo connector token authenticates as Riya
    const raw = result!.connectorUrl!.split('/mcp/')[1];
    expect((await authenticateToken(raw))?.email).toBe(DEMO_EMAILS.riya);

    // Running again without reset refuses; ifMissing is a no-op
    await expect(seedDemo({ verbose: false })).rejects.toThrow(/already exists/);
    expect(await seedDemo({ ifMissing: true, verbose: false })).toBeNull();

    // Reset replaces the org (and the old token stops working)
    const again = await seedDemo({ reset: true, verbose: false });
    expect(again!.orgId).not.toBe(result!.orgId);
    expect(await authenticateToken(raw)).toBeNull();
    const admins = await db.select().from(users).where(eq(users.email, DEMO_EMAILS.admin));
    expect(admins).toHaveLength(1);
  });
});
