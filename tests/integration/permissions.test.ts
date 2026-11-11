/**
 * Permissions: the same rules must hold over MCP and the web app.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClaim, submitClaim } from '../../src/domain/claims.js';
import { revokeToken } from '../../src/domain/tokens.js';
import {
  createTestOrg,
  hasTestDb,
  loginAs,
  mcpClientFor,
  PNG,
  startServer,
  weekdayIso,
  type McpTestClient,
  type TestOrg,
  type TestServer,
} from '../helpers/fixtures.js';

describe.skipIf(!hasTestDb)('permissions', () => {
  let server: TestServer;
  let org: TestOrg;
  let other: TestOrg; // a second organisation
  const date = weekdayIso(10);
  let empClaim: string; // draft owned by org.emp
  let empLine: string;
  let submittedClaim: string; // submitted by org.emp (manager = org.manager)
  let otherTeamClaim: string; // submitted by org.otherEmp (manager = org.otherManager)
  const clients: McpTestClient[] = [];

  beforeAll(async () => {
    server = await startServer();
    [org, other] = await Promise.all([createTestOrg('perm'), createTestOrg('perm-other')]);
    const line = [{ date, merchant: 'Cafe', category: 'Meals', amount: 300 }];
    const a = await createClaim(org.emp.id, org.orgId, { title: 'Draft', expenses: line }, 'web');
    empClaim = a.claimId;
    empLine = a.perLineFlags[0].expenseId;
    const b = await createClaim(org.emp.id, org.orgId, { title: 'Submitted', expenses: line }, 'web');
    await submitClaim(b.claimId, org.emp.id, 'web');
    submittedClaim = b.claimId;
    const c = await createClaim(org.otherEmp.id, org.orgId, { title: 'Other team', expenses: line }, 'web');
    await submitClaim(c.claimId, org.otherEmp.id, 'web');
    otherTeamClaim = c.claimId;
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await server?.close();
  });

  const client = async (user: TestOrg['emp']) => {
    const c = await mcpClientFor(server, user);
    clients.push(c);
    return c;
  };

  describe('over MCP', () => {
    it("an employee's token cannot read, edit or extend another employee's claim", async () => {
      const ed = await client(org.emp2);
      const read = await ed.call('get_claim', { claim_id: empClaim });
      expect(read.isError).toBe(true);
      expect(read.text).toMatch(/permission/);
      expect((await ed.call('update_expense', { expense_id: empLine, amount: 1 })).isError).toBe(true);
      expect((await ed.call('add_expenses', { claim_id: empClaim, expenses: [{ date, merchant: 'X', category: 'Meals', amount: 1 }] })).isError).toBe(true);
      expect((await ed.call('submit_claim', { claim_id: empClaim })).isError).toBe(true);
    });

    it('an employee cannot use approvals or reports', async () => {
      const eve = await client(org.emp);
      expect((await eve.call('list_pending_approvals')).isError).toBe(true);
      expect((await eve.call('decide_claim', { claim_id: submittedClaim, approve_all: true })).isError).toBe(true);
      expect((await eve.call('get_spend_report', { from: weekdayIso(60), to: date, group_by: 'user' })).isError).toBe(true);
    });

    it("a manager cannot see or decide claims from employees outside their team", async () => {
      const mona = await client(org.manager);
      const queue = await mona.call('list_pending_approvals');
      const ids = queue.data.claims.map((c: { claim_id: string }) => c.claim_id);
      expect(ids).toContain(submittedClaim);
      expect(ids).not.toContain(otherTeamClaim);
      expect((await mona.call('get_claim', { claim_id: otherTeamClaim })).isError).toBe(true);
      const decide = await mona.call('decide_claim', { claim_id: otherTeamClaim, approve_all: true });
      expect(decide.isError).toBe(true);
      expect(decide.text).toMatch(/direct reports/);
    });

    it("an admin cannot reach another organisation's claims", async () => {
      const otherAdmin = await client(other.admin);
      expect((await otherAdmin.call('get_claim', { claim_id: submittedClaim })).text).toMatch(/not found/);
      expect((await otherAdmin.call('decide_claim', { claim_id: submittedClaim, approve_all: true })).isError).toBe(true);
    });

    it('a revoked token gets 401', async () => {
      const eve = await client(org.emp);
      expect((await eve.call('get_policy')).isError).toBe(false);
      await revokeToken(org.emp.id, eve.tokenId);

      const res = await fetch(`${server.url}/mcp/${eve.rawToken}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
      expect((await eve.call('get_policy')).isError).toBe(true);
    });

    it("a user cannot revoke someone else's token", async () => {
      const eve = await client(org.emp);
      await expect(revokeToken(org.emp2.id, eve.tokenId)).rejects.toThrow(/not found/);
    });
  });

  describe('over the web', () => {
    it("an employee gets 403 on another employee's claim page", async () => {
      const ed = await loginAs(server, org.emp2);
      expect((await ed.fetch(`/claims/${empClaim}`)).status).toBe(403);
    });

    it('employees cannot open approvals, reports or admin settings', async () => {
      const eve = await loginAs(server, org.emp);
      for (const path of ['/approvals', '/reports', '/reports/export.csv', '/settings/team']) {
        expect((await eve.fetch(path)).status, path).toBe(403);
      }
      expect((await eve.post('/settings/policy', { form: 'policy', receiptRequiredAbove: '1', gstinRequiredAbove: '1' })).status).toBe(403);
    });

    it('managers cannot export CSV or manage the team', async () => {
      const mona = await loginAs(server, org.manager);
      expect((await mona.fetch('/reports')).status).toBe(200);
      expect((await mona.fetch('/reports/export.csv')).status).toBe(403);
      expect((await mona.fetch('/settings/team')).status).toBe(403);
    });

    it('receipts are only served to people who can see the claim', async () => {
      const eve = await loginAs(server, org.emp);
      const form = new FormData();
      form.append('receipt', new Blob([PNG], { type: 'image/png' }), 'r.png');
      form.append('expenseId', empLine);
      const up = await eve.fetch('/upload/receipt', { method: 'POST', body: form, headers: { accept: 'application/json' } });
      expect(up.status).toBe(200);
      const { url } = (await up.json()) as { url: string };

      expect((await eve.fetch(url)).status).toBe(200);
      expect((await (await loginAs(server, org.manager)).fetch(url)).status).toBe(200);
      expect((await (await loginAs(server, org.admin)).fetch(url)).status).toBe(200);
      expect((await (await loginAs(server, org.emp2)).fetch(url)).status).toBe(404);
      expect((await (await loginAs(server, org.otherManager)).fetch(url)).status).toBe(404);
      expect((await (await loginAs(server, other.admin)).fetch(url)).status).toBe(404);
      expect([302, 401]).toContain((await fetch(`${server.url}${url}`, { redirect: 'manual' })).status);
    });

    it("an employee cannot attach a receipt to someone else's line", async () => {
      const ed = await loginAs(server, org.emp2);
      const form = new FormData();
      form.append('receipt', new Blob([PNG], { type: 'image/png' }), 'r.png');
      form.append('expenseId', empLine);
      expect((await ed.fetch('/upload/receipt', { method: 'POST', body: form, headers: { accept: 'application/json' } })).status).toBe(403);
    });

    it('cross-site form posts are blocked', async () => {
      const eve = await loginAs(server, org.emp);
      const res = await eve.fetch(`/claims/${empClaim}/submit`, { method: 'POST', headers: { origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
    });
  });
});
