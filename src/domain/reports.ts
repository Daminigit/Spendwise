/**
 * src/domain/reports.ts
 *
 * Spend reports and CSV export.
 * Managers see only their direct reports; admins see the full org.
 */

import { eq, and, gte, lte, inArray, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/index.js';
import { claims, expenses, users, categories } from '../db/schema.js';
import { paiseToDecimal } from './money.js';
import { csvCell, csvRow } from './csv.js';
import { DomainError } from './errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type GroupBy = 'user' | 'category' | 'month';

export interface ReportRow {
  label: string;
  totalMinor: number;
  approvedMinor: number;
  pendingMinor: number;
  rejectedMinor: number;
  count: number;
}

export interface ReportFilters {
  from: string;   // YYYY-MM-DD
  to: string;     // YYYY-MM-DD
  groupBy: GroupBy;
}

// ─────────────────────────────────────────────────────────────────────────────
// getSpendReport
// ─────────────────────────────────────────────────────────────────────────────

export async function getSpendReport(
  orgId: string,
  actorId: string,
  filters: ReportFilters,
): Promise<ReportRow[]> {
  const [actor] = await db.select().from(users).where(eq(users.id, actorId));
  if (!actor) throw new DomainError('User not found.');
  if (actor.role === 'employee') throw new DomainError('Employees cannot access spend reports.');

  // Determine which user IDs are in scope
  let scopeUserIds: string[] | null = null; // null = all users in org
  if (actor.role === 'manager') {
    const reports = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.managerId, actorId));
    scopeUserIds = [actorId, ...reports.map((r) => r.id)];
  }

  // Build base condition
  // Drafts haven't been submitted yet, so they aren't spend (same rule as the CSV export)
  const baseCondition = and(
    eq(claims.orgId, orgId),
    ne(claims.status, 'draft'),
    gte(expenses.date, filters.from),
    lte(expenses.date, filters.to),
    scopeUserIds ? inArray(claims.userId, scopeUserIds) : undefined,
  );

  if (filters.groupBy === 'user') {
    const rows = await db
      .select({
        label: users.name,
        totalMinor: sql<number>`sum(${expenses.amountMinor})::int`,
        approvedMinor: sql<number>`sum(case when ${expenses.status} = 'approved' then ${expenses.amountMinor} else 0 end)::int`,
        pendingMinor: sql<number>`sum(case when ${expenses.status} = 'pending' then ${expenses.amountMinor} else 0 end)::int`,
        rejectedMinor: sql<number>`sum(case when ${expenses.status} = 'rejected' then ${expenses.amountMinor} else 0 end)::int`,
        count: sql<number>`count(${expenses.id})::int`,
      })
      .from(expenses)
      .innerJoin(claims, eq(expenses.claimId, claims.id))
      .innerJoin(users, eq(claims.userId, users.id))
      .where(baseCondition)
      .groupBy(users.id, users.name)
      .orderBy(sql`sum(${expenses.amountMinor}) desc`);

    return rows as ReportRow[];
  }

  if (filters.groupBy === 'category') {
    const rows = await db
      .select({
        label: categories.name,
        totalMinor: sql<number>`sum(${expenses.amountMinor})::int`,
        approvedMinor: sql<number>`sum(case when ${expenses.status} = 'approved' then ${expenses.amountMinor} else 0 end)::int`,
        pendingMinor: sql<number>`sum(case when ${expenses.status} = 'pending' then ${expenses.amountMinor} else 0 end)::int`,
        rejectedMinor: sql<number>`sum(case when ${expenses.status} = 'rejected' then ${expenses.amountMinor} else 0 end)::int`,
        count: sql<number>`count(${expenses.id})::int`,
      })
      .from(expenses)
      .innerJoin(claims, eq(expenses.claimId, claims.id))
      .innerJoin(categories, eq(expenses.categoryId, categories.id))
      .where(baseCondition)
      .groupBy(categories.id, categories.name)
      .orderBy(sql`sum(${expenses.amountMinor}) desc`);

    return rows as ReportRow[];
  }

  // groupBy === 'month'
  const rows = await db
    .select({
      label: sql<string>`to_char(${expenses.date}::date, 'YYYY-MM')`,
      totalMinor: sql<number>`sum(${expenses.amountMinor})::int`,
      approvedMinor: sql<number>`sum(case when ${expenses.status} = 'approved' then ${expenses.amountMinor} else 0 end)::int`,
      pendingMinor: sql<number>`sum(case when ${expenses.status} = 'pending' then ${expenses.amountMinor} else 0 end)::int`,
      rejectedMinor: sql<number>`sum(case when ${expenses.status} = 'rejected' then ${expenses.amountMinor} else 0 end)::int`,
      count: sql<number>`count(${expenses.id})::int`,
    })
    .from(expenses)
    .innerJoin(claims, eq(expenses.claimId, claims.id))
    .where(baseCondition)
    .groupBy(sql`to_char(${expenses.date}::date, 'YYYY-MM')`)
    .orderBy(sql`to_char(${expenses.date}::date, 'YYYY-MM')`);

  return rows as ReportRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

export type ExportScope = 'approved' | 'all';

export interface ExportFilters {
  from?: string; // YYYY-MM-DD, expense date
  to?: string;
  /**
   * 'approved' (default): approved lines on approved / partly approved / paid
   *   claims — what finance books into Tally / Zoho / Xero.
   * 'all': every line on every non-draft claim, any status.
   */
  scope?: ExportScope;
}

/** Column order matches CONTEXT.md §7. */
export const CSV_HEADER = [
  'claim_id', 'employee', 'email', 'date', 'merchant', 'category',
  'category_code', 'description', 'amount', 'currency', 'taxable',
  'cgst', 'sgst', 'igst', 'gstin', 'payment_method', 'status',
  'approver', 'decided_at', 'paid_at',
] as const;

const BATCH_SIZE = 500;

/**
 * Yield the export as CSV text chunks (header first, then one chunk per batch
 * of rows). Rows are read with keyset pagination, so memory stays flat no
 * matter how many expenses the org has. Admins only.
 */
export async function* streamExpenseCSV(orgId: string, actorId: string, filters: ExportFilters = {}): AsyncGenerator<string> {
  const [actor] = await db.select().from(users).where(eq(users.id, actorId));
  if (!actor || actor.role !== 'admin' || actor.orgId !== orgId) {
    throw new DomainError('Only admins can export CSV.', 'forbidden');
  }

  const scope = filters.scope ?? 'approved';
  const approver = alias(users, 'approver');
  const base = and(
    eq(claims.orgId, orgId),
    ne(claims.status, 'draft'),
    filters.from ? gte(expenses.date, filters.from) : undefined,
    filters.to ? lte(expenses.date, filters.to) : undefined,
    scope === 'approved'
      ? and(eq(expenses.status, 'approved'), inArray(claims.status, ['approved', 'partially_approved', 'paid']))
      : undefined,
  );

  yield csvRow([...CSV_HEADER]);

  let cursor: { date: string; id: string } | null = null;
  for (;;) {
    const rows = await db
      .select({
        id: expenses.id,
        claimId: claims.id,
        employee: users.name,
        email: users.email,
        date: expenses.date,
        merchant: expenses.merchant,
        category: categories.name,
        categoryCode: categories.code,
        description: expenses.description,
        amountMinor: expenses.amountMinor,
        currency: expenses.currency,
        taxableMinor: expenses.taxableMinor,
        cgstMinor: expenses.cgstMinor,
        sgstMinor: expenses.sgstMinor,
        igstMinor: expenses.igstMinor,
        gstin: expenses.gstin,
        paymentMethod: expenses.paymentMethod,
        expenseStatus: expenses.status,
        approverName: approver.name,
        decidedAt: claims.decidedAt,
        paidAt: claims.paidAt,
      })
      .from(expenses)
      .innerJoin(claims, eq(expenses.claimId, claims.id))
      .innerJoin(users, eq(claims.userId, users.id))
      .innerJoin(categories, eq(expenses.categoryId, categories.id))
      .leftJoin(approver, eq(claims.decidedBy, approver.id))
      .where(and(base, cursor ? sql`(${expenses.date}, ${expenses.id}) > (${cursor.date}, ${cursor.id})` : undefined))
      .orderBy(expenses.date, expenses.id)
      .limit(BATCH_SIZE);

    if (rows.length === 0) return;

    let chunk = '';
    for (const r of rows) {
      chunk += csvRow([
        csvCell(r.claimId),
        csvCell(r.employee),
        csvCell(r.email),
        csvCell(r.date),
        csvCell(r.merchant),
        csvCell(r.category),
        csvCell(r.categoryCode),
        csvCell(r.description),
        csvCell(paiseToDecimal(r.amountMinor), { numeric: true }),
        csvCell(r.currency),
        csvCell(paiseToDecimal(r.taxableMinor), { numeric: true }),
        csvCell(paiseToDecimal(r.cgstMinor), { numeric: true }),
        csvCell(paiseToDecimal(r.sgstMinor), { numeric: true }),
        csvCell(paiseToDecimal(r.igstMinor), { numeric: true }),
        csvCell(r.gstin ?? ''),
        csvCell(r.paymentMethod),
        csvCell(r.expenseStatus),
        csvCell(r.approverName ?? ''),
        csvCell(r.decidedAt?.toISOString() ?? ''),
        csvCell(r.paidAt?.toISOString() ?? ''),
      ]);
    }
    yield chunk;

    if (rows.length < BATCH_SIZE) return;
    const last: { date: string; id: string } = rows[rows.length - 1];
    cursor = { date: last.date, id: last.id };
  }
}

/** Whole export as one string (convenience for tests / small orgs). */
export async function generateCSV(orgId: string, actorId: string, filters?: ExportFilters): Promise<string> {
  let out = '';
  for await (const chunk of streamExpenseCSV(orgId, actorId, filters)) out += chunk;
  return out;
}
