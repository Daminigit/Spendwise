/**
 * MCP server over real HTTP (Streamable HTTP, stateless) with the official SDK
 * client: every tool, the self-correcting error messages, and token auth.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateGSTIN } from '../../src/domain/gstin.js';
import {
  createTestOrg,
  hasTestDb,
  mcpClientFor,
  saturdayIso,
  startServer,
  weekdayIso,
  type McpTestClient,
  type TestOrg,
  type TestServer,
} from '../helpers/fixtures.js';

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const VALID_GSTIN = [...ALNUM].map((c) => `29ABCDE1234F1Z${c}`).find(validateGSTIN)!;

describe.skipIf(!hasTestDb)('MCP server', () => {
  let server: TestServer;
  let org: TestOrg;
  let emp: McpTestClient;
  let mgr: McpTestClient;
  let admin: McpTestClient;
  const start = weekdayIso(14);

  beforeAll(async () => {
    server = await startServer();
    org = await createTestOrg('mcp');
    [emp, mgr, admin] = await Promise.all([mcpClientFor(server, org.emp), mcpClientFor(server, org.manager), mcpClientFor(server, org.admin)]);
  });

  afterAll(async () => {
    await Promise.all([emp?.close(), mgr?.close(), admin?.close()]);
    await server?.close();
  });

  const threeReceipts = () => ({
    title: 'Bangalore client visit',
    trip_start: start,
    trip_end: start,
    expenses: [
      { date: start, merchant: 'Truffles', category: 'Meals', amount: 2360, gstin: VALID_GSTIN.toLowerCase(), taxable_amount: 2000, cgst: 180, sgst: 180 },
      { date: start, merchant: 'Hotel Leela', category: 'LODGE', amount: 5000 },
      { date: saturdayIso(2), merchant: 'Uber', category: 'travel', amount: 450, payment_method: 'upi' },
    ],
  });

  describe('transport & auth', () => {
    it('lists the 10 tools', async () => {
      expect(await emp.listTools()).toEqual([
        'add_expenses', 'create_claim', 'decide_claim', 'get_claim', 'get_policy',
        'get_spend_report', 'list_my_claims', 'list_pending_approvals', 'submit_claim', 'update_expense',
      ]);
    });

    it('rejects an unknown token with 401', async () => {
      const res = await fetch(`${server.url}/mcp/sw_not_a_real_token_123456`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/Connect Claude/);
    });

    it('answers GET with 405 (stateless, no SSE stream)', async () => {
      expect((await fetch(`${server.url}/mcp/${emp.rawToken}`)).status).toBe(405);
    });
  });

  it('get_policy returns categories in rupees, thresholds and the caller', async () => {
    const r = await emp.call('get_policy');
    expect(r.isError).toBe(false);
    expect(r.data.categories.find((c: { code: string }) => c.code === 'MEALS')).toMatchObject({ name: 'Meals', per_item_limit: 1500, per_day_limit: 2500 });
    expect(r.data.rules).toMatchObject({ receipt_required_above: 500, gstin_required_above: 2000, weekend_spend_allowed: false });
    expect(r.data.you).toMatchObject({ name: 'Eve Employee', role: 'employee', manager: 'Mona Manager', can_approve: false });
  });

  describe('create_claim', () => {
    it('creates a 3-line draft with correct totals and flags', async () => {
      const r = await emp.call('create_claim', threeReceipts());
      expect(r.isError).toBe(false);
      expect(r.data.status).toBe('draft');
      expect(r.data.lines).toHaveLength(3);
      expect(r.data.totals).toMatchObject({ gross: 7810, taxable: 2000, gst: 360, cgst: 180, sgst: 180 });
      const flags = r.data.lines.map((l: { flags: Array<{ code: string }> }) => l.flags.map((f) => f.code));
      expect(flags[0]).toContain('OVER_ITEM_LIMIT');
      expect(flags[0]).not.toContain('INVALID_GSTIN'); // lower-case GSTIN normalised
      expect(flags[1]).toContain('MISSING_GSTIN');
      expect(flags[2]).toEqual(expect.arrayContaining(['WEEKEND', 'OUTSIDE_TRIP']));
      expect(r.data.app_url).toBe(`http://spendwise.test/claims/${r.data.claim_id}`);
    });

    it('submit=true submits straight away', async () => {
      const r = await emp.call('create_claim', { ...threeReceipts(), title: 'Auto-submit', submit: true });
      expect(r.data.status).toBe('submitted');
    });

    it.each([
      ['unknown category', { category: 'Food' }, /Unknown category 'Food'\. Valid categories: .*Meals/],
      ['non-ISO date', { date: '03/11/2026' }, /YYYY-MM-DD/],
      ['amount as string', { amount: '100' }, /number in rupees/],
      ['zero amount', { amount: 0 }, /more than zero/],
      ['foreign currency', { currency: 'USD' }, /Only INR/],
    ])('explains how to fix: %s', async (_name, override, msg) => {
      const r = await emp.call('create_claim', {
        title: 'Bad',
        expenses: [{ date: start, merchant: 'Cafe', category: 'Meals', amount: 100, ...override }],
      });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(msg);
    });

    it('rejects trip_end before trip_start', async () => {
      const r = await emp.call('create_claim', { ...threeReceipts(), trip_start: start, trip_end: weekdayIso(30) });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/before trip_start/);
    });
  });

  describe('full flow', () => {
    let claimId: string;
    let lineIds: string[];

    it('add_expenses, update_expense, list_my_claims, get_claim', async () => {
      const created = await emp.call('create_claim', threeReceipts());
      claimId = created.data.claim_id;

      const added = await emp.call('add_expenses', { claim_id: claimId, expenses: [{ date: start, merchant: 'Starbucks', category: 'Meals', amount: 320 }] });
      expect(added.data.totals.gross).toBe(8130);

      const hotel = created.data.lines[1].expense_id;
      const empty = await emp.call('update_expense', { expense_id: hotel });
      expect(empty.isError).toBe(true);
      expect(empty.text).toMatch(/Send at least one of/);
      const upd = await emp.call('update_expense', { expense_id: hotel, gstin: VALID_GSTIN });
      expect(upd.data.line.flags.map((f: { code: string }) => f.code)).not.toContain('MISSING_GSTIN');

      const mine = await emp.call('list_my_claims', { status: 'draft' });
      expect(mine.data.claims.map((c: { claim_id: string }) => c.claim_id)).toContain(claimId);

      const detail = await emp.call('get_claim', { claim_id: claimId });
      expect(detail.data.lines).toHaveLength(4);
      expect(detail.data.source).toBe('claude');
      expect(detail.data.history[0]).toMatchObject({ event: 'Created the claim with 3 lines', via: 'claude', by: 'Eve Employee' });
      lineIds = detail.data.lines.map((l: { expense_id: string }) => l.expense_id);
    });

    it('submit_claim → submitted, routed to the manager', async () => {
      const r = await emp.call('submit_claim', { claim_id: claimId });
      expect(r.data).toMatchObject({ status: 'submitted', approver: 'Mona Manager' });
      expect(r.data.flagged_lines.some((l: { flags: Array<{ code: string }> }) => l.flags.some((f) => f.code === 'MISSING_RECEIPT'))).toBe(true);
      expect((await emp.call('submit_claim', { claim_id: claimId })).text).toMatch(/Only draft/);
    });

    it('manager: queue, recategorise, decide → partially_approved', async () => {
      const queue = await mgr.call('list_pending_approvals');
      expect(queue.data.claims.map((c: { claim_id: string }) => c.claim_id)).toContain(claimId);

      const truffles = (await mgr.call('get_claim', { claim_id: claimId })).data.lines.find((l: { merchant: string }) => l.merchant === 'Truffles').expense_id;
      const recat = await mgr.call('update_expense', { expense_id: truffles, category: 'Client Entertainment' });
      expect(recat.data.line.category_code).toBe('ENT');

      expect((await mgr.call('decide_claim', { claim_id: claimId })).text).toMatch(/Nothing to decide/);
      expect((await mgr.call('decide_claim', { claim_id: claimId, approve_all: true, decisions: [{ expense_id: lineIds[0], approve: true }] })).text).toMatch(/not both/);
      expect((await mgr.call('decide_claim', { claim_id: claimId, decisions: [{ expense_id: lineIds[0], approve: true }] })).text).toMatch(
        /Every line needs a decision/,
      );

      const r = await mgr.call('decide_claim', {
        claim_id: claimId,
        decisions: lineIds.map((id, i) => ({ expense_id: id, approve: i !== 2, note: i === 2 ? 'Outside trip dates' : undefined })),
      });
      expect(r.data.status).toBe('partially_approved');

      const after = await admin.call('get_claim', { claim_id: claimId });
      const events = after.data.history as Array<{ event: string; via: string; by: string; note?: string }>;
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: expect.stringMatching(/^Edited line \d \(Truffles\): category Meals → Client Entertainment$/), by: 'Mona Manager', via: 'claude' }),
          expect.objectContaining({ event: expect.stringMatching(/^Rejected line \d \(.+\)$/), note: 'Outside trip dates', by: 'Mona Manager', via: 'claude' }),
          expect.objectContaining({ event: 'Decided: Partly approved', via: 'claude' }),
        ]),
      );
    });

    it('get_spend_report: manager sees their team, admin sees the org', async () => {
      const from = weekdayIso(60);
      const to = weekdayIso(0);
      const m = await mgr.call('get_spend_report', { from, to, group_by: 'category' });
      expect(m.isError).toBe(false);
      expect(m.data.scope).toBe('you and your direct reports');
      expect(m.data.grand_total).toBeGreaterThan(0);
      const a = await admin.call('get_spend_report', { from, to, group_by: 'month' });
      expect(a.data.scope).toBe('organisation');
      expect((await admin.call('get_spend_report', { from: to, to: from, group_by: 'user' })).text).toMatch(/before/);
    });
  });
});
