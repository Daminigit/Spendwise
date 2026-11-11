/**
 * Claim lifecycle through the domain layer (Postgres): create → add → edit →
 * submit → decide → pay, with totals, flags and the audit trail.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/index.js';
import { auditLog, claims as claimsTable } from '../../src/db/schema.js';
import {
  addExpenses,
  createClaim,
  decideClaim,
  getClaim,
  listAwaitingPayment,
  listClaims,
  listPendingApprovals,
  markPaid,
  submitClaim,
  updateExpense,
} from '../../src/domain/claims.js';
import { DomainError } from '../../src/domain/errors.js';
import { getSpendReport } from '../../src/domain/reports.js';
import { createTestOrg, hasTestDb, saturdayIso, weekdayIso, type TestOrg } from '../helpers/fixtures.js';

describe.skipIf(!hasTestDb)('claim lifecycle (domain)', () => {
  let org: TestOrg;
  const tripStart = weekdayIso(30);

  beforeAll(async () => {
    org = await createTestOrg('claims');
  });

  const newClaim = (expenses = [{ date: tripStart, merchant: 'Cafe', category: 'Meals', amount: 400 }], via: 'web' | 'mcp' = 'web') =>
    createClaim(org.emp.id, org.orgId, { title: 'Trip', trip_start: tripStart, trip_end: tripStart, expenses }, via);

  it('creates a draft with paise totals and per-line flags', async () => {
    const r = await createClaim(
      org.emp.id,
      org.orgId,
      {
        title: 'Bangalore',
        trip_start: tripStart,
        trip_end: tripStart,
        expenses: [
          { date: tripStart, merchant: 'Truffles', category: 'MEALS', amount: 1800 }, // over ₹1,500 item limit
          { date: tripStart, merchant: 'Hotel', category: 'Lodging', amount: 5000 }, // > ₹2,000 without GSTIN
          { date: saturdayIso(20), merchant: 'Uber', category: 'travel', amount: 450.5 }, // weekend + outside trip
        ],
      },
      'mcp',
    );
    expect(r.status).toBe('draft');
    expect(r.totals.grossMinor).toBe(725050);
    expect(r.perLineFlags[0].flags).toContain('OVER_ITEM_LIMIT');
    expect(r.perLineFlags[1].flags).toContain('MISSING_GSTIN');
    expect(r.perLineFlags[2].flags).toEqual(expect.arrayContaining(['WEEKEND', 'OUTSIDE_TRIP']));
    expect(r.appUrl).toBe(`http://spendwise.test/claims/${r.claimId}`);

    const [row] = await db.select().from(claimsTable).where(eq(claimsTable.id, r.claimId));
    expect(row.source).toBe('claude');
  });

  it('rejects an unknown category with the list of valid ones', async () => {
    await expect(newClaim([{ date: tripStart, merchant: 'X', category: 'Food', amount: 10 }])).rejects.toThrow(
      /Unknown category 'Food'\. Valid categories: .*Meals \(MEALS\)/,
    );
  });

  it('adds lines to a draft and re-totals; flags same-day overspend', async () => {
    const r = await newClaim([{ date: tripStart, merchant: 'Lunch', category: 'Meals', amount: 1400 }]);
    const added = await addExpenses(r.claimId, org.emp.id, [{ date: tripStart, merchant: 'Dinner', category: 'Meals', amount: 1400 }], 'web');
    expect(added.totals.grossMinor).toBe(280000);
    expect(added.expenseResults[0].flags).toContain('OVER_DAY_LIMIT'); // ₹2,800 > ₹2,500 per day
  });

  it('recomputes flags when a line is edited', async () => {
    const r = await newClaim([{ date: tripStart, merchant: 'Hotel', category: 'Lodging', amount: 5000 }]);
    expect(r.perLineFlags[0].flags).toContain('MISSING_GSTIN');
    const upd = await updateExpense(r.perLineFlags[0].expenseId, org.emp.id, { gstin: '' }, 'web');
    expect(upd.flags).toContain('MISSING_GSTIN');
    const upd2 = await updateExpense(r.perLineFlags[0].expenseId, org.emp.id, { amount: 1500 }, 'web');
    expect(upd2.flags).not.toContain('MISSING_GSTIN');
  });

  it('submit adds MISSING_RECEIPT, locks the draft and routes to the manager', async () => {
    const r = await newClaim([{ date: tripStart, merchant: 'Hotel', category: 'Lodging', amount: 900 }]);
    const s = await submitClaim(r.claimId, org.emp.id, 'web');
    expect(s).toMatchObject({ status: 'submitted', approverName: 'Mona Manager' });

    const c = await getClaim(r.claimId, org.emp.id);
    expect(c.expenses[0].flags).toContain('MISSING_RECEIPT');

    await expect(submitClaim(r.claimId, org.emp.id, 'web')).rejects.toThrow(/Only draft/);
    await expect(updateExpense(c.expenses[0].id, org.emp.id, { amount: 1 }, 'web')).rejects.toThrow(/permission/);
    await expect(addExpenses(r.claimId, org.emp.id, [{ date: tripStart, merchant: 'X', category: 'Meals', amount: 1 }], 'web')).rejects.toThrow(
      /draft/,
    );

    const queue = await listPendingApprovals(org.manager.id);
    expect(queue.map((q) => q.id)).toContain(r.claimId);
  });

  it('refuses to submit an empty claim', async () => {
    const r = await createClaim(org.emp.id, org.orgId, { title: 'Empty', expenses: [] }, 'web');
    await expect(submitClaim(r.claimId, org.emp.id, 'web')).rejects.toThrow(/no expenses/);
  });

  describe('decide', () => {
    async function submitted() {
      const r = await newClaim([
        { date: tripStart, merchant: 'Lunch', category: 'Meals', amount: 300 },
        { date: tripStart, merchant: 'Cab', category: 'Travel', amount: 200 },
        { date: tripStart, merchant: 'Gift', category: 'Other', amount: 100 },
      ]);
      await submitClaim(r.claimId, org.emp.id, 'web');
      return { claimId: r.claimId, ids: r.perLineFlags.map((l) => l.expenseId) };
    }

    it('approve_all → approved', async () => {
      const { claimId } = await submitted();
      expect((await decideClaim(claimId, org.manager.id, [], true, undefined, 'web')).newStatus).toBe('approved');
    });

    it('manager recategorises, rejects one with a note, approves the rest → partially_approved', async () => {
      const { claimId, ids } = await submitted();
      await updateExpense(ids[0], org.manager.id, { category: 'ENT' }, 'web');
      const r = await decideClaim(
        claimId,
        org.manager.id,
        [
          { expenseId: ids[0], approve: true },
          { expenseId: ids[1], approve: true },
          { expenseId: ids[2], approve: false, note: 'Personal, not reimbursable' },
        ],
        false,
        undefined,
        'web',
      );
      expect(r.newStatus).toBe('partially_approved');
      const c = await getClaim(claimId, org.manager.id);
      expect(c.expenses.find((e) => e.id === ids[0])!.categoryCode).toBe('ENT');
      expect(c.expenses.find((e) => e.id === ids[2])).toMatchObject({ status: 'rejected', reviewerNote: 'Personal, not reimbursable' });
      expect(c.decidedBy).toBe(org.manager.id);
    });

    it('rejecting every line → rejected', async () => {
      const { claimId, ids } = await submitted();
      const r = await decideClaim(claimId, org.admin.id, ids.map((id) => ({ expenseId: id, approve: false, note: 'no' })), false, undefined, 'web');
      expect(r.newStatus).toBe('rejected');
    });

    it('validates before writing: missing lines, missing reject note, unknown ids', async () => {
      const { claimId, ids } = await submitted();
      await expect(decideClaim(claimId, org.manager.id, [{ expenseId: ids[0], approve: true }], false, undefined, 'web')).rejects.toThrow(
        /Every line needs a decision/,
      );
      await expect(
        decideClaim(claimId, org.manager.id, ids.map((id, i) => ({ expenseId: id, approve: i > 0 })), false, undefined, 'web'),
      ).rejects.toThrow(/note/);
      await expect(
        decideClaim(claimId, org.manager.id, [...ids.map((id) => ({ expenseId: id, approve: true })), { expenseId: 'nope', approve: true }], false, undefined, 'web'),
      ).rejects.toThrow(/not in this claim/);

      const c = await getClaim(claimId, org.manager.id);
      expect(c.status).toBe('submitted');
      expect(c.expenses.every((e) => e.status === 'pending')).toBe(true);
    });

    it('cannot decide a claim twice or decide a draft', async () => {
      const { claimId } = await submitted();
      await decideClaim(claimId, org.manager.id, [], true, undefined, 'web');
      await expect(decideClaim(claimId, org.manager.id, [], true, undefined, 'web')).rejects.toThrow(/Only submitted/);
      const draft = await newClaim();
      await expect(decideClaim(draft.claimId, org.manager.id, [], true, undefined, 'web')).rejects.toThrow(/Only submitted/);
    });
  });

  describe('markPaid', () => {
    it('pays only approved / partly approved claims and reports which', async () => {
      const ok = await newClaim();
      await submitClaim(ok.claimId, org.emp.id, 'web');
      await decideClaim(ok.claimId, org.manager.id, [], true, undefined, 'web');
      const pending = await newClaim();
      await submitClaim(pending.claimId, org.emp.id, 'web');

      expect((await listAwaitingPayment(org.admin.id)).map((c) => c.id)).toContain(ok.claimId);
      const paid = await markPaid([ok.claimId, pending.claimId], org.admin.id, 'web');
      expect(paid).toEqual([ok.claimId]);
      expect((await getClaim(ok.claimId, org.admin.id)).status).toBe('paid');
      expect((await getClaim(pending.claimId, org.admin.id)).status).toBe('submitted');
    });

    it('is admin-only', async () => {
      await expect(markPaid([], org.manager.id, 'web')).rejects.toBeInstanceOf(DomainError);
    });
  });

  it('writes an audit entry for every change, tagged web or mcp', async () => {
    const r = await newClaim(undefined, 'mcp');
    const lineId = r.perLineFlags[0].expenseId;
    await updateExpense(lineId, org.emp.id, { merchant: 'Cafe Coffee Day' }, 'web');
    await submitClaim(r.claimId, org.emp.id, 'mcp');
    await decideClaim(r.claimId, org.manager.id, [], true, 'ok', 'web');

    const rows = await db
      .select({ action: auditLog.action, via: auditLog.actorVia, entity: auditLog.entity, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), inArray(auditLog.entityId, [r.claimId, lineId])))
      .orderBy(auditLog.createdAt);

    expect(rows).toEqual(
      expect.arrayContaining([
        { action: 'create', via: 'mcp', entity: 'claim', actor: org.emp.id },
        { action: 'update', via: 'web', entity: 'expense', actor: org.emp.id },
        { action: 'submit', via: 'mcp', entity: 'claim', actor: org.emp.id },
        { action: 'approve', via: 'web', entity: 'expense', actor: org.manager.id },
        { action: 'decide', via: 'web', entity: 'claim', actor: org.manager.id },
      ]),
    );
  });

  it('spend reports ignore drafts', async () => {
    const filters = { from: weekdayIso(90), to: weekdayIso(0), groupBy: 'user' as const };
    const total = async () => (await getSpendReport(org.orgId, org.admin.id, filters)).reduce((s, r) => s + r.totalMinor, 0);
    const before = await total();
    await newClaim([{ date: tripStart, merchant: 'Draft only', category: 'Meals', amount: 999 }]);
    expect(await total()).toBe(before);
    const submittedOne = await newClaim([{ date: tripStart, merchant: 'Submitted', category: 'Meals', amount: 10 }]);
    await submitClaim(submittedOne.claimId, org.emp.id, 'web');
    expect(await total()).toBe(before + 1000);
  });

  it('listClaims filters by status', async () => {
    const drafts = await listClaims(org.emp.id, { status: 'draft' });
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((c) => c.status === 'draft')).toBe(true);
  });
});
