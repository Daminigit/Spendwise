/**
 * src/db/seed.ts
 *
 * Demo organisation "Acme Travel Pvt Ltd": 4 users, the 7 standard categories,
 * the demo policy, ~3 months of claims in every status (so reports look real),
 * small PDF receipts, and an MCP connector token for Riya.
 *
 * Claims are created through the real domain functions, so totals, rule flags
 * and audit-log entries are genuine; timestamps are then back-dated.
 *
 *   npm run seed              create the demo org (refuses if it already exists)
 *   npm run seed -- --reset   delete the demo org and recreate it
 *   node dist/db/seed.js      same, in production
 *
 * Password for every demo user: demo1234
 * Set DEMO_MCP_TOKEN (sw_… , 24+ chars) to get a stable connector URL for docs.
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './index.js';
import { auditLog, categories, claims, expenses, mcpTokens, organisations, policy, users } from './schema.js';
import { hashPassword } from '../auth/password.js';
import { createClaim, decideClaim, markPaid, submitClaim, updateExpense, type ExpenseInputRaw } from '../domain/claims.js';
import { DEFAULT_CATEGORIES } from '../domain/org.js';
import { connectorUrl, hashToken } from '../domain/tokens.js';
import { validateGSTIN } from '../domain/gstin.js';
import { uploadReceipt } from '../storage/index.js';

export const DEMO_ORG_NAME = 'Acme Travel Pvt Ltd';
export const DEMO_PASSWORD = 'demo1234';
export const DEMO_EMAILS = {
  admin: 'admin@acme.test',
  manager: 'manager@acme.test',
  riya: 'riya@acme.test',
  arjun: 'arjun@acme.test',
} as const;

// ── Date helpers (relative to today so the demo never goes stale) ────────────

const DAY = 24 * 60 * 60 * 1000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The weekday `daysAgo` days back (Sat/Sun roll back to Friday). */
function weekday(daysAgo: number): Date {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  return d;
}

const plusDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
/** Next Saturday on/after d (used for deliberately flagged weekend spend). */
function saturdayAfter(d: Date): Date {
  const out = new Date(d);
  while (out.getUTCDay() !== 6) out.setUTCDate(out.getUTCDate() + 1);
  return out;
}
/** A timestamp on day d at the given IST-ish hour. */
const at = (d: Date, hour: number) => new Date(d.getTime() + (hour - 5.5) * 60 * 60 * 1000);

// ── Money / GST helpers ──────────────────────────────────────────────────────

/** Split a GST-inclusive amount into taxable + CGST/SGST (intra-state) or IGST. */
function gst(amount: number, rate: number, interState = false) {
  const totalP = Math.round(amount * 100);
  const taxableP = Math.round(totalP / (1 + rate));
  const taxP = totalP - taxableP;
  if (interState) return { taxable_amount: taxableP / 100, igst: taxP / 100 };
  const cgstP = Math.floor(taxP / 2);
  return { taxable_amount: taxableP / 100, cgst: cgstP / 100, sgst: (taxP - cgstP) / 100 };
}

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Complete a 14-char GSTIN prefix with its valid check character (fictional suppliers). */
function gstin(prefix14: string): string {
  const full = [...CHARS].map((c) => prefix14 + c).find(validateGSTIN);
  if (!full) throw new Error(`No valid GSTIN for ${prefix14}`);
  return full;
}

const SUPPLIERS = {
  indigo: gstin('29AAACI4321K1Z'),
  leela: gstin('29AABCL5678M1Z'),
  truffles: gstin('29AAFCT2468P1Z'),
  taj: gstin('27AAACT1357Q1Z'),
  marriott: gstin('36AABCM8642R1Z'),
  zoho: gstin('33AAACZ9753S1Z'),
  croma: gstin('27AAECR3141T1Z'),
  goaResort: gstin('30AAFCG2718U1Z'),
};

// ── Tiny PDF receipts (valid PDF 1.4, hand-assembled — no dependencies) ──────

function pdfEscape(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '');
}

export function receiptPdf(lines: string[]): Buffer {
  const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 14 : 10} Tf 30 ${250 - i * 18} Td (${pdfEscape(l)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 290] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ── Claim scenarios ──────────────────────────────────────────────────────────

type Who = 'riya' | 'arjun' | 'manager';
type Line = ExpenseInputRaw & { receipt?: boolean };
type Outcome =
  | { kind: 'draft' }
  | { kind: 'submitted' }
  | { kind: 'approved'; paid?: boolean }
  | { kind: 'partial'; reject: Record<number, string>; recategorise?: Record<number, string>; paid?: boolean }
  | { kind: 'rejected'; note: string };

interface Scenario {
  who: Who;
  title: string;
  purpose: string;
  start: Date;
  days: number; // trip length; 0 = not a trip
  lines: (start: Date) => Line[];
  outcome: Outcome;
  via?: 'web' | 'mcp';
  approver?: 'manager' | 'admin';
}

function scenarios(): Scenario[] {
  return [
    {
      who: 'riya', title: 'Bangalore client visit', purpose: 'Quarterly review with Infosys procurement team',
      start: weekday(86), days: 3, outcome: { kind: 'approved', paid: true },
      lines: (s) => [
        { date: isoDate(s), merchant: 'IndiGo 6E-512 BOM-BLR', category: 'TRAVEL', amount: 6450, gstin: SUPPLIERS.indigo, ...gst(6450, 0.05, true), receipt: true },
        { date: isoDate(s), merchant: 'The Leela Palace', category: 'LODGE', description: '2 nights', amount: 5900, gstin: SUPPLIERS.leela, ...gst(5900, 0.12), receipt: true },
        { date: isoDate(plusDays(s, 1)), merchant: 'Truffles, Koramangala', category: 'MEALS', description: 'Dinner', amount: 1180, gstin: SUPPLIERS.truffles, ...gst(1180, 0.05), receipt: true },
        { date: isoDate(plusDays(s, 2)), merchant: 'Uber', category: 'TRAVEL', description: 'Hotel to airport', amount: 640, payment_method: 'upi', receipt: true },
      ],
    },
    {
      who: 'arjun', title: 'Hyderabad vendor audit', purpose: 'On-site audit at packaging vendor',
      start: weekday(79), days: 2, outcome: { kind: 'approved', paid: true },
      lines: (s) => [
        { date: isoDate(s), merchant: 'Vande Bharat Express', category: 'TRAVEL', amount: 2350, receipt: true },
        { date: isoDate(s), merchant: 'Hyderabad Marriott', category: 'LODGE', amount: 5600, gstin: SUPPLIERS.marriott, ...gst(5600, 0.12), receipt: true },
        { date: isoDate(plusDays(s, 1)), merchant: 'Paradise Biryani', category: 'MEALS', amount: 720, payment_method: 'upi', receipt: true },
      ],
    },
    {
      who: 'manager', title: 'Leadership offsite, Goa', purpose: 'Annual planning offsite', approver: 'admin',
      start: weekday(72), days: 2, outcome: { kind: 'approved', paid: true },
      lines: (s) => [
        { date: isoDate(s), merchant: 'Air India AI-663', category: 'TRAVEL', amount: 7820, gstin: SUPPLIERS.indigo, ...gst(7820, 0.05, true), receipt: true },
        { date: isoDate(s), merchant: 'Taj Exotica Resort', category: 'LODGE', amount: 5950, gstin: SUPPLIERS.goaResort, ...gst(5950, 0.12), receipt: true },
        { date: isoDate(plusDays(s, 1)), merchant: 'Fisherman\'s Wharf', category: 'ENT', description: 'Team dinner (6 people)', amount: 8400, gstin: SUPPLIERS.goaResort, ...gst(8400, 0.05), receipt: true },
      ],
    },
    {
      who: 'riya', title: 'Software subscriptions', purpose: 'Design and docs tools for the team',
      start: weekday(63), days: 0, outcome: { kind: 'approved', paid: true },
      lines: (s) => [
        { date: isoDate(s), merchant: 'Figma', category: 'SW', description: 'Professional seat, monthly', amount: 1250, payment_method: 'personal_card', receipt: true },
        { date: isoDate(s), merchant: 'Zoho Workplace', category: 'SW', amount: 2124, gstin: SUPPLIERS.zoho, ...gst(2124, 0.18, true), receipt: true },
      ],
    },
    {
      who: 'arjun', title: 'Client dinner, Mumbai', purpose: 'Renewal discussion with Tata Motors fleet team',
      start: weekday(52), days: 0,
      outcome: { kind: 'partial', reject: { 0: 'Above the ₹10,000 entertainment limit without pre-approval. Please resubmit with approval email.' } },
      lines: (s) => [
        { date: isoDate(s), merchant: 'Taj Mahal Palace — Wasabi', category: 'ENT', description: 'Dinner for 4', amount: 14160, gstin: SUPPLIERS.taj, ...gst(14160, 0.18), receipt: true },
        { date: isoDate(s), merchant: 'Ola', category: 'TRAVEL', amount: 480, payment_method: 'upi', receipt: true },
      ],
    },
    {
      who: 'riya', title: 'Pune workshop', purpose: 'Customer onboarding workshop',
      start: weekday(44), days: 2,
      outcome: { kind: 'partial', reject: { 3: 'Weekend coffee is not a business expense.' }, recategorise: { 2: 'ENT' } },
      lines: (s) => [
        { date: isoDate(s), merchant: 'Shatabdi Express', category: 'TRAVEL', amount: 1340, receipt: true },
        { date: isoDate(s), merchant: 'Novotel Pune', category: 'LODGE', amount: 4800, gstin: gstin('27AABCN4826V1Z'), ...gst(4800, 0.12), receipt: true },
        { date: isoDate(plusDays(s, 1)), merchant: 'Malaka Spice', category: 'MEALS', description: 'Lunch with client (3 people)', amount: 2650, receipt: true },
        { date: isoDate(saturdayAfter(s)), merchant: 'Starbucks', category: 'MEALS', amount: 420, payment_method: 'upi' },
      ],
    },
    {
      who: 'arjun', title: 'Weekend trip, Lonavala', purpose: '',
      start: weekday(37), days: 0, outcome: { kind: 'rejected', note: 'Personal travel is not reimbursable.' },
      lines: (s) => [
        { date: isoDate(saturdayAfter(s)), merchant: 'Della Resorts', category: 'LODGE', amount: 9200 },
        { date: isoDate(saturdayAfter(s)), merchant: 'Zomato', category: 'MEALS', amount: 1890, payment_method: 'upi' },
      ],
    },
    {
      who: 'riya', title: 'Laptop accessories', purpose: 'Replacement charger and dock',
      start: weekday(30), days: 0, outcome: { kind: 'approved' },
      lines: (s) => [
        { date: isoDate(s), merchant: 'Croma, Andheri', category: 'OFFICE', description: 'USB-C dock', amount: 6490, gstin: SUPPLIERS.croma, ...gst(6490, 0.18), receipt: true },
        { date: isoDate(s), merchant: 'Croma, Andheri', category: 'OFFICE', description: '65W charger', amount: 2290, gstin: SUPPLIERS.croma, ...gst(2290, 0.18), receipt: true },
      ],
    },
    {
      who: 'arjun', title: 'Chennai sales trip', purpose: 'Dealer meetings, Chennai region',
      start: weekday(17), days: 3, outcome: { kind: 'submitted' },
      lines: (s) => [
        { date: isoDate(s), merchant: 'IndiGo 6E-221 BOM-MAA', category: 'TRAVEL', amount: 5980, gstin: SUPPLIERS.indigo, ...gst(5980, 0.05, true), receipt: true },
        { date: isoDate(s), merchant: 'ITC Grand Chola', category: 'LODGE', amount: 7400, receipt: true },
        { date: isoDate(plusDays(s, 1)), merchant: 'Dakshin', category: 'MEALS', amount: 1450, receipt: true },
        { date: isoDate(plusDays(s, 1)), merchant: 'Murugan Idli Shop', category: 'MEALS', amount: 1280 },
        { date: isoDate(plusDays(s, 2)), merchant: 'Fast Track Taxi', category: 'TRAVEL', amount: 860, payment_method: 'cash' },
      ],
    },
    {
      who: 'manager', title: 'Team lunch', purpose: 'Sprint wrap-up lunch', approver: 'admin',
      start: weekday(11), days: 0, outcome: { kind: 'submitted' },
      lines: (s) => [{ date: isoDate(s), merchant: 'Social, Bandra', category: 'ENT', description: 'Team of 8', amount: 6720, gstin: gstin('27AAJCS5544W1Z'), ...gst(6720, 0.05), receipt: true }],
    },
    {
      who: 'riya', title: 'Office supplies', purpose: 'Stationery for the Mumbai office',
      start: weekday(8), days: 0, outcome: { kind: 'submitted' },
      lines: (s) => [
        { date: isoDate(s), merchant: 'Amazon.in', category: 'OFFICE', description: 'Notebooks and pens', amount: 1340, receipt: true },
        { date: isoDate(s), merchant: 'Staples', category: 'OFFICE', description: 'Whiteboard markers', amount: 380 },
      ],
    },
    {
      who: 'riya', title: 'Delhi conference', purpose: 'NASSCOM Product Conclave', via: 'mcp',
      start: weekday(4), days: 2, outcome: { kind: 'draft' },
      lines: (s) => [
        { date: isoDate(s), merchant: 'Vistara UK-940 BOM-DEL', category: 'TRAVEL', amount: 6210, gstin: SUPPLIERS.indigo, ...gst(6210, 0.05, true) },
        { date: isoDate(s), merchant: 'The Lalit New Delhi', category: 'LODGE', amount: 6890, gstin: gstin('07AABCL7788X1Z'), ...gst(6890, 0.12) },
        { date: isoDate(plusDays(s, 1)), merchant: 'Karim\'s, Jama Masjid', category: 'MEALS', amount: 960, payment_method: 'upi' },
      ],
    },
    {
      who: 'arjun', title: 'Cab rides', purpose: 'Client visits around Mumbai',
      start: weekday(2), days: 0, outcome: { kind: 'draft' },
      lines: (s) => [{ date: isoDate(s), merchant: 'Uber', category: 'TRAVEL', amount: 540, payment_method: 'upi' }],
    },
  ];
}

// ── Back-dating ──────────────────────────────────────────────────────────────

async function backdate(claimId: string, t: { created: Date; submitted?: Date; decided?: Date; paid?: Date }) {
  await db
    .update(claims)
    .set({
      createdAt: t.created,
      updatedAt: t.paid ?? t.decided ?? t.submitted ?? t.created,
      ...(t.submitted ? { submittedAt: t.submitted } : {}),
      ...(t.decided ? { decidedAt: t.decided } : {}),
      ...(t.paid ? { paidAt: t.paid } : {}),
    })
    .where(eq(claims.id, claimId));

  const exps = await db.select({ id: expenses.id }).from(expenses).where(eq(expenses.claimId, claimId));
  const ids = [claimId, ...exps.map((e) => e.id)];
  await db.update(expenses).set({ createdAt: t.created, updatedAt: t.decided ?? t.created }).where(eq(expenses.claimId, claimId));

  const stamp = (d: Date | undefined, fallback: Date) => (d ?? fallback).toISOString();
  await db
    .update(auditLog)
    .set({
      createdAt: sql`case
        when ${auditLog.action} in ('submit') then ${stamp(t.submitted, t.created)}::timestamptz
        when ${auditLog.action} in ('approve', 'reject') then ${stamp(t.decided, t.created)}::timestamptz
        when ${auditLog.action} = 'decide' then ${stamp(t.decided, t.created)}::timestamptz + interval '1 minute'
        when ${auditLog.action} = 'mark_paid' then ${stamp(t.paid, t.created)}::timestamptz
        when ${auditLog.action} = 'update' and ${auditLog.actorUserId} <> (select user_id from claims where id = ${claimId})
          then ${stamp(t.decided, t.created)}::timestamptz - interval '10 minutes'
        when ${auditLog.action} = 'update' then ${t.created.toISOString()}::timestamptz + interval '20 minutes'
        else ${t.created.toISOString()}::timestamptz
      end`,
    })
    .where(inArray(auditLog.entityId, ids));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function findDemoOrgId(): Promise<string | null> {
  const [admin] = await db.select({ orgId: users.orgId }).from(users).where(eq(users.email, DEMO_EMAILS.admin));
  return admin?.orgId ?? null;
}

export interface SeedOptions {
  /** Delete an existing demo org first. */
  reset?: boolean;
  /** Do nothing (quietly) if the demo org already exists. */
  ifMissing?: boolean;
  /** Log progress (default true). */
  verbose?: boolean;
}

export interface SeedResult {
  orgId: string;
  connectorUrl: string | null;
  userIds: Record<keyof typeof DEMO_EMAILS, string>;
}

export async function seedDemo(opts: SeedOptions = {}): Promise<SeedResult | null> {
  const log = opts.verbose === false ? () => {} : console.log;
  const existing = await findDemoOrgId();
  if (existing) {
    if (opts.ifMissing) {
      log('Demo org already exists — skipping seed.');
      return null;
    }
    if (!opts.reset) {
      throw new Error(`Demo org already exists. Run with --reset to recreate it.`);
    }
    // Claims first (cascades to expenses + comments): expenses reference
    // categories and claims reference users without ON DELETE CASCADE.
    await db.transaction(async (tx) => {
      await tx.delete(claims).where(eq(claims.orgId, existing));
      // Then the org cascades to users, tokens, policy, categories, audit log
      await tx.delete(organisations).where(eq(organisations.id, existing));
    });
    log('Deleted existing demo org.');
  }

  log(`Seeding ${DEMO_ORG_NAME}…`);
  const orgId = randomUUID();
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const ids = { admin: randomUUID(), manager: randomUUID(), riya: randomUUID(), arjun: randomUUID() };

  await db.transaction(async (tx) => {
    await tx.insert(organisations).values({ id: orgId, name: DEMO_ORG_NAME, baseCurrency: 'INR', createdAt: new Date(Date.now() - 100 * DAY) });
    await tx.insert(users).values([
      { id: ids.admin, orgId, email: DEMO_EMAILS.admin, name: 'Kavita Rao', passwordHash, role: 'admin', managerId: null },
      { id: ids.manager, orgId, email: DEMO_EMAILS.manager, name: 'Priya Sharma', passwordHash, role: 'manager', managerId: ids.admin },
      { id: ids.riya, orgId, email: DEMO_EMAILS.riya, name: 'Riya Patel', passwordHash, role: 'employee', managerId: ids.manager },
      { id: ids.arjun, orgId, email: DEMO_EMAILS.arjun, name: 'Arjun Mehta', passwordHash, role: 'employee', managerId: ids.manager },
    ]);
    await tx.insert(policy).values({
      orgId,
      receiptRequiredAboveMinor: 50000,
      gstinRequiredAboveMinor: 200000,
      allowWeekendSpend: false,
      notes:
        'Book economy class for flights under 4 hours. Hotels up to ₹6,000/night in metros. ' +
        'Client entertainment above ₹10,000 needs prior approval from your manager — attach the approval email. ' +
        'Alcohol is not reimbursable. Submit claims within 30 days of the expense.',
    });
    await tx.insert(categories).values(DEFAULT_CATEGORIES.map((c) => ({ id: randomUUID(), orgId, ...c })));
  });

  const owner = { riya: ids.riya, arjun: ids.arjun, manager: ids.manager };

  for (const sc of scenarios()) {
    const userId = owner[sc.who];
    const lines = sc.lines(sc.start);
    const via = sc.via ?? 'web';
    const result = await createClaim(
      userId,
      orgId,
      {
        title: sc.title,
        purpose: sc.purpose,
        trip_start: sc.days ? isoDate(sc.start) : undefined,
        trip_end: sc.days ? isoDate(plusDays(sc.start, sc.days - 1)) : undefined,
        expenses: lines.map(({ receipt: _r, ...l }) => l),
      },
      via,
    );
    const expIds = result.perLineFlags.map((l) => l.expenseId);

    // Attach receipts (the employee does this on the web after Claude logs the claim)
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].receipt) continue;
      const l = lines[i];
      const pdf = receiptPdf([
        l.merchant,
        `Date: ${l.date}`,
        l.description ? `Item: ${l.description}` : 'Item: as billed',
        l.gstin ? `GSTIN: ${l.gstin}` : 'GSTIN: -',
        l.taxable_amount ? `Taxable: Rs ${l.taxable_amount.toFixed(2)}` : '',
        l.cgst ? `CGST: Rs ${l.cgst.toFixed(2)}  SGST: Rs ${(l.sgst ?? 0).toFixed(2)}` : l.igst ? `IGST: Rs ${l.igst.toFixed(2)}` : '',
        `TOTAL: Rs ${l.amount.toFixed(2)}`,
        'Demo receipt - Spendwise seed data',
      ].filter(Boolean));
      const { url } = await uploadReceipt(pdf);
      await updateExpense(expIds[i], userId, { receipt_url: url }, 'web');
    }

    const created = at(sc.start, 9 + (sc.days || 1) * 2);
    const tripEnd = plusDays(sc.start, Math.max(sc.days - 1, 0));
    const submitted = at(plusDays(tripEnd, 1), 10);
    const decided = at(plusDays(tripEnd, 3), 15);
    const paid = at(plusDays(tripEnd, 9), 11);

    if (sc.outcome.kind === 'draft') {
      await backdate(result.claimId, { created });
      continue;
    }

    await submitClaim(result.claimId, userId, 'web');
    if (sc.outcome.kind === 'submitted') {
      await backdate(result.claimId, { created, submitted });
      continue;
    }

    const approverId = sc.approver === 'admin' ? ids.admin : ids.manager;
    const o = sc.outcome;
    if (o.kind === 'partial' && o.recategorise) {
      for (const [idx, code] of Object.entries(o.recategorise)) {
        await updateExpense(expIds[Number(idx)], approverId, { category: code }, 'web');
      }
    }
    if (o.kind === 'approved') {
      await decideClaim(result.claimId, approverId, [], true, undefined, 'web');
    } else if (o.kind === 'rejected') {
      await decideClaim(result.claimId, approverId, expIds.map((id) => ({ expenseId: id, approve: false, note: o.note })), false, undefined, 'web');
    } else {
      const rejectIdx = Object.keys(o.reject).map(Number);
      await decideClaim(
        result.claimId,
        approverId,
        expIds.map((id, i) => ({ expenseId: id, approve: !rejectIdx.includes(i), note: o.reject[i] })),
        false,
        undefined,
        'web',
      );
    }

    const willPay = (o.kind === 'approved' || o.kind === 'partial') && o.paid;
    if (willPay) await markPaid([result.claimId], ids.admin, 'web');
    await backdate(result.claimId, { created, submitted, decided, ...(willPay ? { paid } : {}) });
  }

  // A comment thread on the partly approved Mumbai dinner
  const [mumbai] = await db.select({ id: claims.id }).from(claims).where(and(eq(claims.orgId, orgId), eq(claims.title, 'Client dinner, Mumbai')));
  if (mumbai) {
    const { comments } = await import('./schema.js');
    await db.insert(comments).values([
      { id: randomUUID(), claimId: mumbai.id, userId: ids.manager, body: 'Approved the cab. The dinner is over the entertainment limit — please get pre-approval next time.', createdAt: weekday(49) },
      { id: randomUUID(), claimId: mumbai.id, userId: ids.arjun, body: 'Understood, will attach the approval email and resubmit.', createdAt: plusDays(weekday(49), 0.1) },
    ]);
  }

  // Demo MCP connector token for Riya
  let rawToken = process.env.DEMO_MCP_TOKEN?.trim() || `sw_${randomUUID().replace(/-/g, '')}`;
  if (!/^sw_[A-Za-z0-9_-]{20,}$/.test(rawToken)) {
    console.warn('DEMO_MCP_TOKEN is not of the form sw_<20+ url-safe chars>; generating a random one instead.');
    rawToken = `sw_${randomUUID().replace(/-/g, '')}`;
  }
  // A fixed DEMO_MCP_TOKEN may still be on a token row from an older org
  await db.delete(mcpTokens).where(eq(mcpTokens.tokenHash, hashToken(rawToken)));
  await db.insert(mcpTokens).values({ id: randomUUID(), userId: ids.riya, tokenHash: hashToken(rawToken), label: 'Demo token (Riya)' });
  const url = connectorUrl(rawToken);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(claims).where(eq(claims.orgId, orgId));
  log(`\nSeed complete: ${count} claims.\n`);
  log(`Demo accounts (password: ${DEMO_PASSWORD})`);
  log(`  ${DEMO_EMAILS.admin.padEnd(20)} admin / finance (Kavita Rao)`);
  log(`  ${DEMO_EMAILS.manager.padEnd(20)} manager (Priya Sharma)`);
  log(`  ${DEMO_EMAILS.riya.padEnd(20)} employee (Riya Patel)`);
  log(`  ${DEMO_EMAILS.arjun.padEnd(20)} employee (Arjun Mehta)\n`);
  log(`Riya's MCP connector URL (add to Claude as a custom connector):\n  ${url}\n`);

  return { orgId, connectorUrl: url, userIds: ids };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDemo({ reset: process.argv.includes('--reset') })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
