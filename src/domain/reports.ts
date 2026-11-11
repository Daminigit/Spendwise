/**
 * src/domain/reports.ts
 *
 * Spend reports and CSV export.
 * Managers see only their direct reports; admins see the full org.
 */

import { eq, and, gte, lte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { claims, expenses, users, categories } from '../db/schema.js';
import { toRupees } from './money.js';
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
  const baseCondition = and(
    eq(claims.orgId, orgId),
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
// generateCSV
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a CSV string for all approved/paid expenses in the org.
 * Columns match the spec in CONTEXT.md §7.
 */
export async function generateCSV(
  orgId: string,
  actorId: string,
  filters?: { from?: string; to?: string },
): Promise<string> {
  const [actor] = await db.select().from(users).where(eq(users.id, actorId));
  if (!actor || actor.role !== 'admin') throw new DomainError('Only admins can export CSV.');

  const rows = await db
    .select({
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
      decidedAt: claims.decidedAt,
      paidAt: claims.paidAt,
      approverName: sql<string | null>`(select u2.name from users u2 where u2.id = ${claims.decidedBy})`,
    })
    .from(expenses)
    .innerJoin(claims, eq(expenses.claimId, claims.id))
    .innerJoin(users, eq(claims.userId, users.id))
    .innerJoin(categories, eq(expenses.categoryId, categories.id))
    .where(
      and(
        eq(claims.orgId, orgId),
        filters?.from ? gte(expenses.date, filters.from) : undefined,
        filters?.to ? lte(expenses.date, filters.to) : undefined,
      ),
    )
    .orderBy(expenses.date, claims.id);

  const header = [
    'claim_id', 'employee', 'email', 'date', 'merchant', 'category',
    'category_code', 'description', 'amount', 'currency', 'taxable',
    'cgst', 'sgst', 'igst', 'gstin', 'payment_method', 'status',
    'approver', 'decided_at', 'paid_at',
  ];

  const csvEscape = (val: unknown): string => {
    const str = val == null ? '' : String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines: string[] = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.claimId,
      r.employee,
      r.email,
      r.date,
      r.merchant,
      r.category,
      r.categoryCode,
      r.description,
      toRupees(r.amountMinor).toFixed(2),
      r.currency,
      toRupees(r.taxableMinor).toFixed(2),
      toRupees(r.cgstMinor).toFixed(2),
      toRupees(r.sgstMinor).toFixed(2),
      toRupees(r.igstMinor).toFixed(2),
      r.gstin ?? '',
      r.paymentMethod,
      r.expenseStatus,
      r.approverName ?? '',
      r.decidedAt?.toISOString() ?? '',
      r.paidAt?.toISOString() ?? '',
    ].map(csvEscape).join(','));
  }

  return lines.join('\r\n');
}

