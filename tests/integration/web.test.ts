/**
 * Web app flows over HTTP: auth, signup + invites, claim editing, approvals,
 * CSV export and settings.
 */

import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClaim, decideClaim, getClaim, markPaid, submitClaim } from '../../src/domain/claims.js';
import { createInvite } from '../../src/domain/org.js';
import {
  createTestOrg,
  hasTestDb,
  loginAs,
  PASSWORD,
  startServer,
  weekdayIso,
  type TestOrg,
  type TestServer,
} from '../helpers/fixtures.js';

describe.skipIf(!hasTestDb)('web app', () => {
  let server: TestServer;
  let org: TestOrg;
  const date = weekdayIso(12);

  beforeAll(async () => {
    server = await startServer();
    org = await createTestOrg('web');
  });
  afterAll(async () => server?.close());

  const form = (fields: Record<string, string>) => ({
    method: 'POST',
    redirect: 'manual' as const,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });

  describe('auth', () => {
    it('serves the landing page and health check', async () => {
      const home = await fetch(server.url);
      expect(home.status).toBe(200);
      expect(await home.text()).toMatch(/How it works/);
      expect(await (await fetch(`${server.url}/healthz`)).json()).toEqual({ ok: true });
    });

    it('redirects signed-out users to login with ?next', async () => {
      const r = await fetch(`${server.url}/claims`, { redirect: 'manual' });
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe('/login?next=%2Fclaims');
    });

    it('rejects a wrong password without saying which part was wrong', async () => {
      const r = await fetch(`${server.url}/login`, form({ email: org.emp.email, password: 'nope' }));
      expect(r.status).toBe(400);
      expect(await r.text()).toMatch(/Email or password is incorrect/);
    });

    it('never redirects off-site after login', async () => {
      const r = await fetch(`${server.url}/login`, form({ email: org.emp.email, password: PASSWORD, next: '//evil.example/x' }));
      expect(r.headers.get('location')).toBe('/claims');
    });

    it('logs out', async () => {
      const s = await loginAs(server, org.emp);
      expect((await s.fetch('/claims')).status).toBe(200);
      await s.post('/logout', {});
      expect((await s.fetch('/claims')).status).toBe(302);
    });
  });

  describe('signup', () => {
    it('creates an organisation with default categories and makes the user admin', async () => {
      const email = `founder.${randomUUID().slice(0, 8)}@example.test`;
      const r = await fetch(`${server.url}/signup`, form({ orgName: 'Newco', name: 'Nia', email, password: 'longenough1' }));
      expect(r.status).toBe(303);
      expect(r.headers.get('location')).toBe('/settings/connect');
      const s = await loginAs(server, { email }, 'longenough1');
      const policy = await (await s.fetch('/settings/policy')).text();
      expect(policy).toMatch(/value="MEALS"/);
      expect((await s.fetch('/settings/team')).status).toBe(200); // admin
    });

    it('refuses a duplicate email and a short password', async () => {
      expect(await (await fetch(`${server.url}/signup`, form({ orgName: 'X', name: 'X', email: org.emp.email, password: 'longenough1' }))).text()).toMatch(
        /already exists/,
      );
      expect(await (await fetch(`${server.url}/signup`, form({ orgName: 'X', name: 'X', email: 'x@example.test', password: 'short' }))).text()).toMatch(
        /at least 8/,
      );
    });

    it('joins an existing org through an invite link with the invited role and manager', async () => {
      const { token } = await createInvite(org.admin.id, 'employee', org.manager.id);
      const page = await (await fetch(`${server.url}/signup?invite=${encodeURIComponent(token)}`)).text();
      expect(page).toMatch(/Join Org web-/);

      const email = `invitee.${randomUUID().slice(0, 8)}@example.test`;
      const r = await fetch(`${server.url}/signup`, form({ invite: token, name: 'Ivy', email, password: 'longenough1' }));
      expect(r.status).toBe(303);

      const mona = await loginAs(server, org.manager);
      const ivy = await loginAs(server, { email }, 'longenough1');
      const created = await ivy.post('/claims', { title: 'Ivy trip' });
      const claimPath = created.headers.get('location')!;
      await ivy.post(`${claimPath}/lines`, { date, merchant: 'Cafe', category: 'MEALS', amount: '250' });
      await ivy.post(`${claimPath}/submit`, {});
      expect(await (await mona.fetch('/approvals')).text()).toContain(claimPath);
    });

    it('rejects a tampered invite', async () => {
      const { token } = await createInvite(org.admin.id, 'admin', null);
      const r = await fetch(`${server.url}/signup?invite=${encodeURIComponent(token.slice(0, -2) + 'xx')}`);
      expect(await r.text()).toMatch(/invalid or has expired/);
    });
  });

  describe('claims', () => {
    it('creates a draft, adds a line, edits it and submits', async () => {
      const eve = await loginAs(server, org.emp);
      const created = await eve.post('/claims', { title: 'Web trip', trip_start: date, trip_end: date });
      const path = created.headers.get('location')!;
      expect(path).toMatch(/^\/claims\/[0-9a-f-]{36}$/);

      await eve.post(`${path}/lines`, {
        date, merchant: 'Hotel', category: 'LODGE', amount: '2,360.00', gstin: '', taxable_amount: '2000', cgst: '180', sgst: '180',
      });
      const id = path.split('/').pop()!;
      const [line] = (await getClaim(id, org.emp.id)).expenses;
      expect(line).toMatchObject({ amountMinor: 236000, taxableMinor: 200000, cgstMinor: 18000 });

      // A partial post (only some fields) must leave the others untouched
      await eve.post(`${path}/edit`, { 'lines[0][id]': line.id, 'lines[0][merchant]': 'Hotel Leela' });
      const [edited] = (await getClaim(id, org.emp.id)).expenses;
      expect(edited).toMatchObject({ merchant: 'Hotel Leela', taxableMinor: 200000, cgstMinor: 18000, sgstMinor: 18000 });
      expect(await (await eve.fetch(path)).text()).toContain('Edited line 1 (Hotel Leela): merchant &#34;Hotel&#34; → &#34;Hotel Leela&#34;');

      // Invalid input comes back as a flash message on the same page
      const bad = await eve.fetch(`${path}/lines`, {
        ...form({ date, merchant: 'X', category: 'MEALS', amount: 'abc' }),
        headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${server.url}${path}` },
      });
      expect(bad.headers.get('location')).toBe(path);
      expect(await (await eve.fetch(path)).text()).toMatch(/must be an amount/);

      await eve.post(`${path}/submit`, {});
      expect((await getClaim(id, org.emp.id)).status).toBe('submitted');
    });

    it('manager decides from the claim page; rejecting needs a note', async () => {
      const c = await createClaim(org.emp.id, org.orgId, {
        title: 'To decide',
        expenses: [
          { date, merchant: 'A', category: 'Meals', amount: 100 },
          { date, merchant: 'B', category: 'Meals', amount: 200 },
        ],
      }, 'web');
      await submitClaim(c.claimId, org.emp.id, 'web');
      const [a, b] = c.perLineFlags.map((l) => l.expenseId);
      const mona = await loginAs(server, org.manager);

      const detail = await (await mona.fetch(`/claims/${c.claimId}`)).text();
      expect(detail).toMatch(/id="decide"/);

      const noNote = await mona.fetch(`/approvals/${c.claimId}/decide`, {
        ...form({ action: 'apply', [`decisions[${a}]`]: 'approve', [`decisions[${b}]`]: 'reject' }),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      });
      expect(noNote.status).toBe(400);

      await mona.post(`/approvals/${c.claimId}/decide`, {
        action: 'apply', [`decisions[${a}]`]: 'approve', [`decisions[${b}]`]: 'reject', [`notes[${b}]`]: 'Personal',
      });
      expect((await getClaim(c.claimId, org.manager.id)).status).toBe('partially_approved');

      // The claim page history shows each line-level decision, who made it and the channel
      const page = await (await mona.fetch(`/claims/${c.claimId}`)).text();
      expect(page).toContain('Rejected line 2 (B)');
      expect(page).toContain('“Personal”');
      expect(page).toMatch(/Approved line 1 \(A\)[\s\S]*?Mona Manager[\s\S]*?via web/);
      expect(page).toContain('Decided: Partly approved');
    });

    it('admin bulk mark-paid only pays approved claims', async () => {
      const c = await createClaim(org.emp.id, org.orgId, { title: 'Pay me', expenses: [{ date, merchant: 'A', category: 'Meals', amount: 100 }] }, 'web');
      await submitClaim(c.claimId, org.emp.id, 'web');
      await decideClaim(c.claimId, org.manager.id, [], true, undefined, 'web');
      const admin = await loginAs(server, org.admin);
      expect(await (await admin.fetch('/approvals')).text()).toContain(`value="${c.claimId}"`);
      await admin.post('/approvals/mark-paid', { ids: c.claimId });
      expect((await getClaim(c.claimId, org.admin.id)).status).toBe('paid');
    });
  });

  describe('reports & CSV', () => {
    let csvClaim: string;

    beforeAll(async () => {
      const c = await createClaim(org.emp2.id, org.orgId, {
        title: 'CSV',
        expenses: [
          { date, merchant: '=HYPERLINK("http://evil","x")', category: 'Meals', amount: 1234.56, description: 'Lunch, "team"' },
          { date, merchant: 'Truffles, Koramangala', category: 'Meals', amount: 999.99, taxable_amount: 909.99, cgst: 45, sgst: 45 },
          { date, merchant: 'Rejected cab', category: 'Travel', amount: 300 },
        ],
      }, 'web');
      await submitClaim(c.claimId, org.emp2.id, 'web');
      const ids = c.perLineFlags.map((l) => l.expenseId);
      await decideClaim(c.claimId, org.manager.id, ids.map((id, i) => ({ expenseId: id, approve: i < 2, note: i === 2 ? 'no' : undefined })), false, undefined, 'web');
      await markPaid([c.claimId], org.admin.id, 'web');
      csvClaim = c.claimId;
      // A draft must never be exported
      await createClaim(org.emp2.id, org.orgId, { title: 'Draft', expenses: [{ date, merchant: 'DRAFT-ONLY', category: 'Meals', amount: 1 }] }, 'web');
    });

    it('report page shows totals grouped by month', async () => {
      const admin = await loginAs(server, org.admin);
      const html = await (await admin.fetch(`/reports?groupBy=month&from=${weekdayIso(60)}&to=${weekdayIso(0)}`)).text();
      expect(html).toContain(date.slice(0, 7));
      expect(html).toMatch(/₹/);
    });

    it('exports approved lines as Excel-friendly CSV', async () => {
      const admin = await loginAs(server, org.admin);
      const res = await admin.fetch(`/reports/export.csv?from=${date}&to=${date}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/csv/);
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="spendwise-export-approved-${date}-to-${date}.csv"`);

      const bytes = Buffer.from(await res.arrayBuffer());
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM
      const rows = bytes.toString('utf8').slice(1).trimEnd().split('\r\n');
      expect(rows[0]).toBe(
        'claim_id,employee,email,date,merchant,category,category_code,description,amount,currency,taxable,cgst,sgst,igst,gstin,payment_method,status,approver,decided_at,paid_at',
      );
      const mine = rows.filter((r) => r.startsWith(csvClaim));
      expect(mine).toHaveLength(2); // rejected line excluded
      expect(mine.some((r) => r.includes(`"'=HYPERLINK(""http://evil"",""x"")"`))).toBe(true);
      expect(mine.some((r) => r.includes('"Lunch, ""team"""'))).toBe(true);
      expect(mine.some((r) => r.includes(',999.99,INR,909.99,45.00,45.00,0.00,'))).toBe(true);
      expect(mine.every((r) => r.includes('Mona Manager'))).toBe(true);
      expect(rows.join('\n')).not.toContain('DRAFT-ONLY');
    });

    it('scope=all includes rejected lines but still no drafts', async () => {
      const admin = await loginAs(server, org.admin);
      const text = await (await admin.fetch(`/reports/export.csv?from=${date}&to=${date}&scope=all`)).text();
      expect(text).toContain('Rejected cab');
      expect(text).not.toContain('DRAFT-ONLY');
    });
  });

  describe('settings', () => {
    it('admin edits policy and adds a category', async () => {
      const admin = await loginAs(server, org.admin);
      await admin.post('/settings/policy', { form: 'policy', receiptRequiredAbove: '750', gstinRequiredAbove: '2500', allowWeekendSpend: 'on', notes: 'Be frugal' });
      await admin.post('/settings/policy', { form: 'categories', 'categories[0][name]': 'Training', 'categories[0][code]': 'TRAIN', 'categories[0][perItemLimit]': '5000', 'categories[0][active]': 'on' });
      const html = await (await admin.fetch('/settings/policy')).text();
      expect(html).toMatch(/value="750\.00"/);
      expect(html).toMatch(/value="TRAIN"/);
      expect(html).toContain('Be frugal');
    });

    it('rejects a duplicate category code', async () => {
      const admin = await loginAs(server, org.admin);
      const r = await admin.fetch('/settings/policy', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ form: 'categories', 'categories[0][name]': 'Meals 2', 'categories[0][code]': 'MEALS', 'categories[1][name]': 'M3', 'categories[1][code]': 'MEALS' }),
      });
      expect(r.status).toBe(409);
    });

    it('shows a new connector URL exactly once, then lists the token', async () => {
      const eve = await loginAs(server, org.emp);
      await eve.post('/settings/connect', { action: 'create', label: 'Laptop' });
      const first = await (await eve.fetch('/settings/connect')).text();
      expect(first).toMatch(/http:\/\/spendwise\.test\/mcp\/sw_[A-Za-z0-9_-]+/);
      const second = await (await eve.fetch('/settings/connect')).text();
      expect(second).not.toMatch(/\/mcp\/sw_/);
      expect(second).toContain('Laptop');
    });

    it('admin cannot demote the last admin', async () => {
      const admin = await loginAs(server, org.admin);
      const r = await admin.fetch('/settings/team', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ memberId: org.admin.id, role: 'manager', managerId: '' }),
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(/at least one admin/);
    });
  });
});
