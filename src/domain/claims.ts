/**
 * src/domain/claims.ts
 *
 * Core claim lifecycle — called by BOTH web routes and MCP tools.
 * No Express/HTTP concerns here; just pure business logic + DB writes.
 *
 * Every write also appends to audit_log.
 */

import { randomUUID } from 'crypto';
import { eq, and, inArray, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  claims,
  expenses,
  categories,
  policy,
  users,
  auditLog,
  comments,
} from '../db/schema.js';
import type {
  Claim,
  ClaimStatus,
  Expense,
  ExpenseStatus,
  AuditVia,
  Category,
  Comment,
  AuditLog,
} from '../db/schema.js';
import { toPaise, sumPaise } from './money.js';
import { DomainError } from './errors.js';
import { checkExpense, checkSubmit, type FlagCode } from './rules.js';

// ─────────────────────────────────────────────────────────────────────────────
// Input / output shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpenseInputRaw {
  date: string;                 // YYYY-MM-DD
  merchant: string;
  category: string;             // name OR code
  description?: string;
  amount: number;               // major units (₹); server converts to paise
  currency?: string;
  gstin?: string;
  taxable_amount?: number;
  cgst?: number;
  sgst?: number;
  igst?: number;
  payment_method?: Expense['paymentMethod'];
}

export interface CreateClaimInput {
  title: string;
  purpose?: string;
  trip_start?: string;
  trip_end?: string;
  expenses: ExpenseInputRaw[];
  submit?: boolean;             // if true, auto-submit after create
}

export interface ClaimTotals {
  grossMinor: number;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
}

export interface ExpenseResult {
  expenseId: string;
  flags: FlagCode[];
}

export interface ClaimResult {
  claimId: string;
  status: ClaimStatus;
  totals: ClaimTotals;
  perLineFlags: ExpenseResult[];
  appUrl: string;
}

export interface ClaimSummary {
  id: string;
  title: string;
  status: ClaimStatus;
  source: Claim['source'];
  totalMinor: number;
  expenseCount: number;
  flagCount: number;
  submittedAt: Date | null;
  createdAt: Date;
  user?: { id: string; name: string; email: string };
}

export interface ClaimDetail extends Claim {
  expenses: Array<Expense & { categoryName: string; categoryCode: string }>;
  comments: Array<Comment & { userName: string }>;
  history: AuditLog[];
  user: { id: string; name: string; email: string };
  totals: ClaimTotals;
}

export interface DecisionInput {
  expenseId: string;
  approve: boolean;
  note?: string;
}

export interface DecideResult {
  claimId: string;
  newStatus: ClaimStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function newId() {
  return randomUUID();
}

function appUrl(claimId: string): string {
  return `${process.env.APP_URL ?? 'http://localhost:3000'}/claims/${claimId}`;
}

async function writeAudit(params: {
  orgId: string;
  actorUserId: string;
  actorVia: AuditVia;
  entity: string;
  entityId: string;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}) {
  await db.insert(auditLog).values({
    id: newId(),
    orgId: params.orgId,
    actorUserId: params.actorUserId,
    actorVia: params.actorVia,
    entity: params.entity,
    entityId: params.entityId,
    action: params.action,
    before: params.before ?? null,
    after: params.after ?? null,
  });
}

function computeTotals(expList: Pick<Expense, 'amountMinor' | 'taxableMinor' | 'cgstMinor' | 'sgstMinor' | 'igstMinor'>[]): ClaimTotals {
  return {
    grossMinor: sumPaise(expList.map((e) => e.amountMinor)),
    taxableMinor: sumPaise(expList.map((e) => e.taxableMinor)),
    cgstMinor: sumPaise(expList.map((e) => e.cgstMinor)),
    sgstMinor: sumPaise(expList.map((e) => e.sgstMinor)),
    igstMinor: sumPaise(expList.map((e) => e.igstMinor)),
  };
}

/** Resolve a category by name or code within an org. */
async function resolveCategory(
  orgId: string,
  nameOrCode: string,
  allCats: Category[],
): Promise<Category> {
  const upper = nameOrCode.trim().toUpperCase();
  const cat = allCats.find(
    (c) =>
      c.active &&
      (c.name.toUpperCase() === upper || c.code.toUpperCase() === upper),
  );
  if (!cat) {
    const valid = allCats
      .filter((c) => c.active)
      .map((c) => `${c.name} (${c.code})`)
      .join(', ');
    throw new DomainError(
      `Unknown category '${nameOrCode}'. Valid categories: ${valid}.`,
    );
  }
  return cat;
}

/** Determine claim status from its expense statuses. */
function deriveClaimStatus(expStatuses: ExpenseStatus[]): ClaimStatus {
  if (expStatuses.every((s) => s === 'approved')) return 'approved';
  if (expStatuses.every((s) => s === 'rejected')) return 'rejected';
  if (expStatuses.some((s) => s === 'approved' || s === 'rejected')) return 'partially_approved';
  return 'submitted';
}

// ─────────────────────────────────────────────────────────────────────────────
// createClaim
// ─────────────────────────────────────────────────────────────────────────────

export async function createClaim(
  userId: string,
  orgId: string,
  input: CreateClaimInput,
  via: AuditVia,
): Promise<ClaimResult> {
  // Load policy + categories once
  const [pol] = await db.select().from(policy).where(eq(policy.orgId, orgId));
  if (!pol) throw new DomainError('Organisation policy not found.');

  const allCats = await db.select().from(categories).where(eq(categories.orgId, orgId));

  // Load existing user expenses for duplicate check
  const existingUserExpenses = await db
    .select({
      id: expenses.id,
      claimId: expenses.claimId,
      date: expenses.date,
      merchant: expenses.merchant,
      categoryId: expenses.categoryId,
      amountMinor: expenses.amountMinor,
    })
    .from(expenses)
    .innerJoin(claims, eq(expenses.claimId, claims.id))
    .where(eq(claims.userId, userId));

  const claimId = newId();

  // Build expense rows + compute flags
  const expenseRows: typeof expenses.$inferInsert[] = [];
  const perLineFlags: ExpenseResult[] = [];

  for (const raw of input.expenses) {
    const cat = await resolveCategory(orgId, raw.category, allCats);
    const amountMinor = toPaise(raw.amount);
    const taxableMinor = toPaise(raw.taxable_amount ?? 0);
    const cgstMinor = toPaise(raw.cgst ?? 0);
    const sgstMinor = toPaise(raw.sgst ?? 0);
    const igstMinor = toPaise(raw.igst ?? 0);

    const expId = newId();

    const expInput = {
      id: expId,
      claimId,
      date: raw.date,
      merchant: raw.merchant,
      categoryId: cat.id,
      amountMinor,
      gstin: raw.gstin ?? null,
      taxableMinor,
      cgstMinor,
      sgstMinor,
      igstMinor,
    };

    // Same-day same-category expenses from existing user data
    const sameDayExisting = existingUserExpenses.filter(
      (e) => e.date === raw.date && e.categoryId === cat.id,
    );
    // Also accumulate within this batch
    const sameDayBatch = expenseRows
      .filter((e) => e.date === raw.date && e.categoryId === cat.id)
      .map((e) => ({
        id: e.id as string,
        claimId: e.claimId as string,
        date: e.date as string,
        merchant: e.merchant as string,
        categoryId: e.categoryId as string,
        amountMinor: e.amountMinor as number,
      }));

    const flags = checkExpense(
      expInput,
      { userId, tripStart: input.trip_start, tripEnd: input.trip_end },
      pol,
      cat,
      [...sameDayExisting, ...sameDayBatch],
      existingUserExpenses,
    );

    expenseRows.push({
      id: expId,
      claimId,
      date: raw.date,
      merchant: raw.merchant,
      categoryId: cat.id,
      description: raw.description ?? '',
      amountMinor,
      currency: raw.currency ?? 'INR',
      gstin: raw.gstin ?? null,
      taxableMinor,
      cgstMinor,
      sgstMinor,
      igstMinor,
      paymentMethod: raw.payment_method ?? 'personal_card',
      flags,
    });

    perLineFlags.push({ expenseId: expId, flags });
  }

  // Insert claim + expenses in a transaction
  await db.transaction(async (tx) => {
    await tx.insert(claims).values({
      id: claimId,
      orgId,
      userId,
      title: input.title,
      purpose: input.purpose ?? '',
      tripStart: input.trip_start ?? null,
      tripEnd: input.trip_end ?? null,
      status: 'draft',
      source: via === 'mcp' ? 'claude' : 'web',
    });

    if (expenseRows.length > 0) {
      await tx.insert(expenses).values(expenseRows);
    }
  });

  await writeAudit({
    orgId,
    actorUserId: userId,
    actorVia: via,
    entity: 'claim',
    entityId: claimId,
    action: 'create',
    after: { title: input.title, expenseCount: expenseRows.length },
  });

  const totals = computeTotals(
    expenseRows.map((e) => ({
      amountMinor: e.amountMinor as number,
      taxableMinor: e.taxableMinor as number,
      cgstMinor: e.cgstMinor as number,
      sgstMinor: e.sgstMinor as number,
      igstMinor: e.igstMinor as number,
    })),
  );

  // Auto-submit if requested
  let status: ClaimStatus = 'draft';
  if (input.submit) {
    const submitResult = await submitClaim(claimId, userId, via);
    status = submitResult.status;
  }

  return { claimId, status, totals, perLineFlags, appUrl: appUrl(claimId) };
}

// ─────────────────────────────────────────────────────────────────────────────
// addExpenses
// ─────────────────────────────────────────────────────────────────────────────

export async function addExpenses(
  claimId: string,
  userId: string,
  expInputs: ExpenseInputRaw[],
  via: AuditVia,
): Promise<{ expenseResults: ExpenseResult[]; totals: ClaimTotals }> {
  const [claim] = await db.select().from(claims).where(eq(claims.id, claimId));
  if (!claim) throw new DomainError('Claim not found.');
  if (claim.userId !== userId) throw new DomainError('You do not own this claim.');
  if (claim.status !== 'draft') throw new DomainError('Expenses can only be added to draft claims.');

  const [pol] = await db.select().from(policy).where(eq(policy.orgId, claim.orgId));
  const allCats = await db.select().from(categories).where(eq(categories.orgId, claim.orgId));

  const existingUserExpenses = await db
    .select({ id: expenses.id, claimId: expenses.claimId, date: expenses.date, merchant: expenses.merchant, categoryId: expenses.categoryId, amountMinor: expenses.amountMinor })
    .from(expenses)
    .innerJoin(claims, eq(expenses.claimId, claims.id))
    .where(eq(claims.userId, userId));

  const newRows: typeof expenses.$inferInsert[] = [];
  const expenseResults: ExpenseResult[] = [];

  for (const raw of expInputs) {
    const cat = await resolveCategory(claim.orgId, raw.category, allCats);
    const amountMinor = toPaise(raw.amount);
    const taxableMinor = toPaise(raw.taxable_amount ?? 0);
    const cgstMinor = toPaise(raw.cgst ?? 0);
    const sgstMinor = toPaise(raw.sgst ?? 0);
    const igstMinor = toPaise(raw.igst ?? 0);
    const expId = newId();

    const sameDayExisting = existingUserExpenses.filter(
      (e) => e.date === raw.date && e.categoryId === cat.id,
    );
    const sameDayBatch = newRows
      .filter((e) => e.date === raw.date && e.categoryId === cat.id)
      .map((e) => ({ id: e.id as string, claimId: e.claimId as string, date: e.date as string, merchant: e.merchant as string, categoryId: e.categoryId as string, amountMinor: e.amountMinor as number }));

    const flags = checkExpense(
      { id: expId, claimId, date: raw.date, merchant: raw.merchant, categoryId: cat.id, amountMinor, gstin: raw.gstin, taxableMinor, cgstMinor, sgstMinor, igstMinor },
      { userId, tripStart: claim.tripStart, tripEnd: claim.tripEnd },
      pol,
      cat,
      [...sameDayExisting, ...sameDayBatch],
      existingUserExpenses,
    );

    newRows.push({ id: expId, claimId, date: raw.date, merchant: raw.merchant, categoryId: cat.id, description: raw.description ?? '', amountMinor, currency: raw.currency ?? 'INR', gstin: raw.gstin ?? null, taxableMinor, cgstMinor, sgstMinor, igstMinor, paymentMethod: raw.payment_method ?? 'personal_card', flags });
    expenseResults.push({ expenseId: expId, flags });
  }

  if (newRows.length > 0) {
    await db.insert(expenses).values(newRows);
  }

  await writeAudit({ orgId: claim.orgId, actorUserId: userId, actorVia: via, entity: 'claim', entityId: claimId, action: 'add_expenses', after: { count: newRows.length } });

  const allExp = await db.select().from(expenses).where(eq(expenses.claimId, claimId));
  return { expenseResults, totals: computeTotals(allExp) };
}

// ─────────────────────────────────────────────────────────────────────────────
// updateExpense
// ─────────────────────────────────────────────────────────────────────────────

export async function updateExpense(
  expenseId: string,
  userId: string,
  fields: Partial<ExpenseInputRaw & { receipt_url: string }>,
  via: AuditVia,
): Promise<ExpenseResult> {
  const [exp] = await db.select().from(expenses).where(eq(expenses.id, expenseId));
  if (!exp) throw new DomainError('Expense not found.');

  const [claim] = await db.select().from(claims).where(eq(claims.id, exp.claimId));
  if (!claim) throw new DomainError('Parent claim not found.');

  const [actor] = await db.select().from(users).where(eq(users.id, userId));
  if (!actor) throw new DomainError('User not found.');

  // Permission: owner (draft) OR manager/admin approver
  const isOwner = claim.userId === userId && claim.status === 'draft';
  let isApprover = false;
  if (claim.status === 'submitted' && actor.orgId === claim.orgId) {
    if (actor.role === 'admin') {
      isApprover = true;
    } else if (actor.role === 'manager') {
      const [owner] = await db.select({ managerId: users.managerId }).from(users).where(eq(users.id, claim.userId));
      isApprover = owner?.managerId === userId;
    }
  }
  if (!isOwner && !isApprover) {
    throw new DomainError('You do not have permission to edit this expense.');
  }

  const [pol] = await db.select().from(policy).where(eq(policy.orgId, claim.orgId));
  const allCats = await db.select().from(categories).where(eq(categories.orgId, claim.orgId));

  // Resolve updated category if provided
  let categoryId = exp.categoryId;
  if (fields.category) {
    const cat = await resolveCategory(claim.orgId, fields.category, allCats);
    categoryId = cat.id;
  }

  const amountMinor = fields.amount !== undefined ? toPaise(fields.amount) : exp.amountMinor;
  const taxableMinor = fields.taxable_amount !== undefined ? toPaise(fields.taxable_amount) : exp.taxableMinor;
  const cgstMinor = fields.cgst !== undefined ? toPaise(fields.cgst) : exp.cgstMinor;
  const sgstMinor = fields.sgst !== undefined ? toPaise(fields.sgst) : exp.sgstMinor;
  const igstMinor = fields.igst !== undefined ? toPaise(fields.igst) : exp.igstMinor;
  const date = fields.date ?? exp.date;
  const merchant = fields.merchant ?? exp.merchant;
  // Blank GSTIN clears it; otherwise normalise to upper-case
  const gstin = fields.gstin !== undefined ? (fields.gstin.trim() ? fields.gstin.trim().toUpperCase() : null) : exp.gstin;


  // Recompute flags
  const existingUserExpenses = await db
    .select({ id: expenses.id, claimId: expenses.claimId, date: expenses.date, merchant: expenses.merchant, categoryId: expenses.categoryId, amountMinor: expenses.amountMinor })
    .from(expenses)
    .innerJoin(claims, eq(expenses.claimId, claims.id))
    .where(and(eq(claims.userId, claim.userId), ne(expenses.id, expenseId)));

  const cat = allCats.find((c) => c.id === categoryId)!;
  const sameDayExisting = existingUserExpenses.filter((e) => e.date === date && e.categoryId === categoryId);
  const flags = checkExpense(
    { id: expenseId, claimId: exp.claimId, date, merchant, categoryId, amountMinor, gstin, taxableMinor, cgstMinor, sgstMinor, igstMinor },
    { userId: claim.userId, tripStart: claim.tripStart, tripEnd: claim.tripEnd },
    pol,
    cat,
    sameDayExisting,
    existingUserExpenses,
  );

  const before: Record<string, unknown> = { amount: exp.amountMinor, categoryId: exp.categoryId, date: exp.date };

  await db.update(expenses)
    .set({
      categoryId,
      amountMinor,
      taxableMinor,
      cgstMinor,
      sgstMinor,
      igstMinor,
      date,
      merchant,
      gstin: gstin ?? null,
      description: fields.description ?? exp.description,
      paymentMethod: fields.payment_method ?? exp.paymentMethod,
      receiptUrl: fields.receipt_url ?? exp.receiptUrl,
      flags,
      updatedAt: new Date(),
    })
    .where(eq(expenses.id, expenseId));

  await writeAudit({ orgId: claim.orgId, actorUserId: userId, actorVia: via, entity: 'expense', entityId: expenseId, action: 'update', before, after: { amount: amountMinor, categoryId, date } });

  return { expenseId, flags };
}

// ─────────────────────────────────────────────────────────────────────────────
// submitClaim
// ─────────────────────────────────────────────────────────────────────────────

export async function submitClaim(
  claimId: string,
  userId: string,
  via: AuditVia = 'web',
): Promise<{ claimId: string; status: ClaimStatus; approverName: string | null }> {
  const [claim] = await db.select().from(claims).where(eq(claims.id, claimId));
  if (!claim) throw new DomainError('Claim not found.');
  if (claim.userId !== userId) throw new DomainError('You do not own this claim.');
  if (claim.status !== 'draft') throw new DomainError('Only draft claims can be submitted.');

  const expList = await db.select().from(expenses).where(eq(expenses.claimId, claimId));
  if (expList.length === 0) throw new DomainError('Cannot submit a claim with no expenses.');

  const [pol] = await db.select().from(policy).where(eq(policy.orgId, claim.orgId));

  // Run submit-time checks (MISSING_RECEIPT)
  const submitFlags = checkSubmit(
    expList.map((e) => ({ ...e, id: e.id })),
    pol,
  );

  // Merge submit flags into each expense
  for (const [eid, extraFlags] of submitFlags.entries()) {
    const exp = expList.find((e) => e.id === eid)!;
    const merged = Array.from(new Set([...(exp.flags as FlagCode[]), ...extraFlags]));
    await db.update(expenses).set({ flags: merged, updatedAt: new Date() }).where(eq(expenses.id, eid));
  }

  await db.update(claims).set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() }).where(eq(claims.id, claimId));

  // Find approver name
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  let approverName: string | null = null;
  if (user?.managerId) {
    const [mgr] = await db.select().from(users).where(eq(users.id, user.managerId));
    approverName = mgr?.name ?? null;
  }

  await writeAudit({ orgId: claim.orgId, actorUserId: userId, actorVia: via, entity: 'claim', entityId: claimId, action: 'submit', before: { status: 'draft' }, after: { status: 'submitted' } });

  return { claimId, status: 'submitted', approverName };
}

// ─────────────────────────────────────────────────────────────────────────────
// decideClaim
// ─────────────────────────────────────────────────────────────────────────────

export async function decideClaim(
  claimId: string,
  actorId: string,
  decisions: DecisionInput[],
  approveAll: boolean,
  note: string | undefined,
  via: AuditVia,
): Promise<DecideResult> {
  const [claim] = await db.select().from(claims).where(eq(claims.id, claimId));
  if (!claim) throw new DomainError('Claim not found.');
  if (claim.status !== 'submitted') throw new DomainError('Only submitted claims can be decided.');

  const [actor] = await db.select().from(users).where(eq(users.id, actorId));
  if (!actor) throw new DomainError('Actor not found.');
  if (actor.orgId !== claim.orgId) throw new DomainError('Claim not found.');

  // Permission check
  if (actor.role === 'employee') throw new DomainError('Employees cannot approve claims.');
  if (actor.role === 'manager') {
    // Manager can only decide claims from their direct reports
    const [claimOwner] = await db.select().from(users).where(eq(users.id, claim.userId));
    if (!claimOwner || claimOwner.managerId !== actorId) {
      throw new DomainError('You can only approve claims from your direct reports.');
    }
  }

  const expList = await db.select().from(expenses).where(eq(expenses.claimId, claimId));

  if (approveAll) {
    for (const exp of expList) {
      await db.update(expenses)
        .set({ status: 'approved', reviewerNote: note ?? null, updatedAt: new Date() })
        .where(eq(expenses.id, exp.id));
      await writeAudit({ orgId: claim.orgId, actorUserId: actorId, actorVia: via, entity: 'expense', entityId: exp.id, action: 'approve', before: { status: exp.status }, after: { status: 'approved', note } });
    }
  } else {
    for (const d of decisions) {
      const exp = expList.find((e) => e.id === d.expenseId);
      if (!exp) throw new DomainError(`Expense ${d.expenseId} not found in this claim.`);
      const newStatus: ExpenseStatus = d.approve ? 'approved' : 'rejected';
      await db.update(expenses)
        .set({ status: newStatus, reviewerNote: d.note ?? null, updatedAt: new Date() })
        .where(eq(expenses.id, d.expenseId));
      await writeAudit({ orgId: claim.orgId, actorUserId: actorId, actorVia: via, entity: 'expense', entityId: d.expenseId, action: d.approve ? 'approve' : 'reject', before: { status: exp.status }, after: { status: newStatus, note: d.note } });
    }
  }

  // Re-read updated statuses
  const updatedExp = await db.select({ status: expenses.status }).from(expenses).where(eq(expenses.claimId, claimId));
  const newClaimStatus = deriveClaimStatus(updatedExp.map((e) => e.status as ExpenseStatus));

  await db.update(claims)
    .set({ status: newClaimStatus, decidedAt: new Date(), decidedBy: actorId, updatedAt: new Date() })
    .where(eq(claims.id, claimId));

  await writeAudit({ orgId: claim.orgId, actorUserId: actorId, actorVia: via, entity: 'claim', entityId: claimId, action: 'decide', before: { status: claim.status }, after: { status: newClaimStatus } });

  return { claimId, newStatus: newClaimStatus };
}

// ─────────────────────────────────────────────────────────────────────────────
// getClaim
// ─────────────────────────────────────────────────────────────────────────────

export async function getClaim(claimId: string, actorId: string): Promise<ClaimDetail> {
  const [claim] = await db.select().from(claims).where(eq(claims.id, claimId));
  if (!claim) throw new DomainError('Claim not found.');

  const [actor] = await db.select().from(users).where(eq(users.id, actorId));
  if (!actor) throw new DomainError('Actor not found.');

  // Permission: owner, or manager of owner, or admin of the same org
  if (actor.orgId !== claim.orgId) {
    throw new DomainError('Claim not found.');
  }
  if (actor.role === 'employee' && claim.userId !== actorId) {
    throw new DomainError('You do not have permission to view this claim.');
  }
  if (actor.role === 'manager' && claim.userId !== actorId) {
    const [owner] = await db.select().from(users).where(eq(users.id, claim.userId));
    if (!owner || owner.managerId !== actorId) {
      throw new DomainError('You do not have permission to view this claim.');
    }
  }

  const expList = await db
    .select({
      id: expenses.id,
      claimId: expenses.claimId,
      date: expenses.date,
      merchant: expenses.merchant,
      categoryId: expenses.categoryId,
      description: expenses.description,
      amountMinor: expenses.amountMinor,
      currency: expenses.currency,
      fxRate: expenses.fxRate,
      gstin: expenses.gstin,
      taxableMinor: expenses.taxableMinor,
      cgstMinor: expenses.cgstMinor,
      sgstMinor: expenses.sgstMinor,
      igstMinor: expenses.igstMinor,
      paymentMethod: expenses.paymentMethod,
      receiptUrl: expenses.receiptUrl,
      status: expenses.status,
      reviewerNote: expenses.reviewerNote,
      flags: expenses.flags,
      createdAt: expenses.createdAt,
      updatedAt: expenses.updatedAt,
      categoryName: schema.categories.name,
      categoryCode: schema.categories.code,
    })
    .from(expenses)
    .innerJoin(schema.categories, eq(expenses.categoryId, schema.categories.id))
    .where(eq(expenses.claimId, claimId));

  const commentList = await db
    .select({
      id: comments.id,
      claimId: comments.claimId,
      userId: comments.userId,
      body: comments.body,
      createdAt: comments.createdAt,
      userName: users.name,
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(eq(comments.claimId, claimId))
    .orderBy(comments.createdAt);

  const history = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entity, 'claim'), eq(auditLog.entityId, claimId)))
    .orderBy(auditLog.createdAt);

  const [owner] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, claim.userId));

  return {
    ...claim,
    expenses: expList as Array<Expense & { categoryName: string; categoryCode: string }>,
    comments: commentList as Array<Comment & { userName: string }>,
    history,
    user: owner,
    totals: computeTotals(expList),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// listClaims (my claims)
// ─────────────────────────────────────────────────────────────────────────────

export async function listClaims(
  userId: string,
  filters?: { status?: ClaimStatus; from?: string; to?: string },
): Promise<ClaimSummary[]> {
  const rows = await db
    .select({
      id: claims.id,
      title: claims.title,
      status: claims.status,
      source: claims.source,
      submittedAt: claims.submittedAt,
      createdAt: claims.createdAt,
      expenseCount: sql<number>`count(${expenses.id})::int`,
      totalMinor: sql<number>`coalesce(sum(${expenses.amountMinor}), 0)::int`,
      flagCount: sql<number>`coalesce(sum(json_array_length(${expenses.flags})), 0)::int`,
    })
    .from(claims)
    .leftJoin(expenses, eq(expenses.claimId, claims.id))
    .where(
      and(
        eq(claims.userId, userId),
        filters?.status ? eq(claims.status, filters.status) : undefined,
        filters?.from ? sql`${claims.createdAt} >= ${filters.from}` : undefined,
        filters?.to ? sql`${claims.createdAt} <= ${filters.to}` : undefined,
      ),
    )
    .groupBy(claims.id)
    .orderBy(sql`${claims.createdAt} desc`);

  return rows as ClaimSummary[];
}

// ─────────────────────────────────────────────────────────────────────────────
// listPendingApprovals
// ─────────────────────────────────────────────────────────────────────────────

export async function listPendingApprovals(actorId: string): Promise<ClaimSummary[]> {
  const [actor] = await db.select().from(users).where(eq(users.id, actorId));
  if (!actor) throw new DomainError('User not found.');
  if (actor.role === 'employee') throw new DomainError('Employees cannot access the approval queue.');

  // Managers see direct reports; admins see all
  let subQuery;
  if (actor.role === 'manager') {
    const reports = await db.select({ id: users.id }).from(users).where(eq(users.managerId, actorId));
    const reportIds = reports.map((r) => r.id);
    if (reportIds.length === 0) return [];
    subQuery = and(eq(claims.status, 'submitted'), inArray(claims.userId, reportIds));
  } else {
    subQuery = and(eq(claims.status, 'submitted'), eq(claims.orgId, actor.orgId));
  }

  const rows = await db
    .select({
      id: claims.id,
      title: claims.title,
      status: claims.status,
      source: claims.source,
      submittedAt: claims.submittedAt,
      createdAt: claims.createdAt,
      expenseCount: sql<number>`count(${expenses.id})::int`,
      totalMinor: sql<number>`coalesce(sum(${expenses.amountMinor}), 0)::int`,
      flagCount: sql<number>`coalesce(sum(json_array_length(${expenses.flags})), 0)::int`,
      userId: claims.userId,
      userName: users.name,
      userEmail: users.email,
    })
    .from(claims)
    .innerJoin(users, eq(claims.userId, users.id))
    .leftJoin(expenses, eq(expenses.claimId, claims.id))
    .where(subQuery)
    .groupBy(claims.id, users.id)
    .orderBy(claims.submittedAt);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status as ClaimStatus,
    source: r.source as Claim['source'],
    totalMinor: r.totalMinor,
    expenseCount: r.expenseCount,
    flagCount: r.flagCount,
    submittedAt: r.submittedAt,
    createdAt: r.createdAt,
    user: { id: r.userId, name: r.userName, email: r.userEmail },
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// markPaid
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the ids that were actually marked paid (others are skipped). */
export async function markPaid(claimIds: string[], actorId: string, via: AuditVia): Promise<string[]> {
  const [actor] = await db.select().from(users).where(eq(users.id, actorId));
  if (!actor || actor.role !== 'admin') throw new DomainError('Only admins can mark claims as paid.');

  if (claimIds.length === 0) return [];

  // Only approved / partially approved claims in the actor's org can be paid
  const updated = await db.update(claims)
    .set({ status: 'paid', paidAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        inArray(claims.id, claimIds),
        eq(claims.orgId, actor.orgId),
        inArray(claims.status, ['approved', 'partially_approved']),
      ),
    )
    .returning({ id: claims.id });

  for (const { id: cid } of updated) {
    await writeAudit({ orgId: actor.orgId, actorUserId: actorId, actorVia: via, entity: 'claim', entityId: cid, action: 'mark_paid', after: { status: 'paid' } });
  }
  return updated.map((u) => u.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// addComment
// ─────────────────────────────────────────────────────────────────────────────

export async function addComment(
  claimId: string,
  userId: string,
  body: string,
  via: AuditVia,
): Promise<Comment> {
  const [claim] = await db.select().from(claims).where(eq(claims.id, claimId));
  if (!claim) throw new DomainError('Claim not found.');

  const commentId = newId();
  const [comment] = await db.insert(comments).values({ id: commentId, claimId, userId, body }).returning();

  await writeAudit({ orgId: claim.orgId, actorUserId: userId, actorVia: via, entity: 'comment', entityId: commentId, action: 'create', after: { body } });

  return comment;
}


// ─────────────────────────────────────────────────────────────────────────────
// listAwaitingPayment (admin: approved claims not yet paid)
// ─────────────────────────────────────────────────────────────────────────────

export async function listAwaitingPayment(actorId: string): Promise<ClaimSummary[]> {
  const [actor] = await db.select().from(users).where(eq(users.id, actorId));
  if (!actor || actor.role !== 'admin') throw new DomainError('Only admins can view claims awaiting payment.');

  const rows = await db
    .select({
      id: claims.id,
      title: claims.title,
      status: claims.status,
      source: claims.source,
      submittedAt: claims.submittedAt,
      createdAt: claims.createdAt,
      expenseCount: sql<number>`count(${expenses.id})::int`,
      // Only approved lines are reimbursed
      totalMinor: sql<number>`coalesce(sum(case when ${expenses.status} = 'approved' then ${expenses.amountMinor} else 0 end), 0)::int`,
      flagCount: sql<number>`coalesce(sum(json_array_length(${expenses.flags})), 0)::int`,
      userId: claims.userId,
      userName: users.name,
      userEmail: users.email,
    })
    .from(claims)
    .innerJoin(users, eq(claims.userId, users.id))
    .leftJoin(expenses, eq(expenses.claimId, claims.id))
    .where(and(eq(claims.orgId, actor.orgId), inArray(claims.status, ['approved', 'partially_approved'])))
    .groupBy(claims.id, users.id)
    .orderBy(claims.decidedAt);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status as ClaimStatus,
    source: r.source as Claim['source'],
    totalMinor: r.totalMinor,
    expenseCount: r.expenseCount,
    flagCount: r.flagCount,
    submittedAt: r.submittedAt,
    createdAt: r.createdAt,
    user: { id: r.userId, name: r.userName, email: r.userEmail },
  }));
}
