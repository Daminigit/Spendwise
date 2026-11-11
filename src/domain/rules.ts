/**
 * src/domain/rules.ts
 *
 * Deterministic rule checks run on every expense create/update.
 * Returns an array of flag codes (warnings for the approver, never blockers).
 *
 * All 9 flags from CONTEXT.md are implemented here:
 *   OVER_ITEM_LIMIT, OVER_DAY_LIMIT, MISSING_RECEIPT, MISSING_GSTIN,
 *   GST_MISMATCH, WEEKEND, OUTSIDE_TRIP, POSSIBLE_DUPLICATE, INVALID_GSTIN
 */

import { withinTolerance } from './money.js';
import { validateGSTIN } from './gstin.js';
import type { Category, Policy } from '../db/schema.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FlagCode =
  | 'OVER_ITEM_LIMIT'
  | 'OVER_DAY_LIMIT'
  | 'MISSING_RECEIPT'
  | 'MISSING_GSTIN'
  | 'GST_MISMATCH'
  | 'WEEKEND'
  | 'OUTSIDE_TRIP'
  | 'POSSIBLE_DUPLICATE'
  | 'INVALID_GSTIN';

/** Minimal shape of an expense needed for rule-checking (avoids circular deps). */
export interface ExpenseInput {
  id?: string;          // undefined for new expenses
  claimId?: string;
  date: string;         // YYYY-MM-DD
  merchant: string;
  categoryId: string;
  amountMinor: number;
  gstin?: string | null;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  receiptUrl?: string | null;
}

/** Minimal claim context. */
export interface ClaimContext {
  userId: string;
  tripStart?: string | null;
  tripEnd?: string | null;
}

/** Minimal expense from DB used for duplicate + day-limit checks. */
export interface ExistingExpense {
  id: string;
  claimId: string;
  date: string;
  merchant: string;
  categoryId: string;
  amountMinor: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual checks
// ─────────────────────────────────────────────────────────────────────────────

function isWeekend(dateStr: string): boolean {
  const d = new Date(`${dateStr}T00:00:00`);
  const dow = d.getDay(); // 0 = Sun, 6 = Sat
  return dow === 0 || dow === 6;
}

function isOutsideTrip(
  dateStr: string,
  tripStart?: string | null,
  tripEnd?: string | null,
): boolean {
  if (!tripStart || !tripEnd) return false; // no trip dates → skip
  return dateStr < tripStart || dateStr > tripEnd;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main check function (run on create / update — before submit)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check a single expense against policy, category limits, and existing expenses.
 *
 * @param expense      The expense being created/updated.
 * @param claim        Context from the parent claim.
 * @param pol          The org's policy row.
 * @param category     The category row for this expense.
 * @param sameDay      All OTHER approved/pending expenses for the same user on the same date
 *                     and same category (excluding this expense). Used for OVER_DAY_LIMIT.
 * @param allUserExp   All OTHER expenses from the same user (any date) for POSSIBLE_DUPLICATE.
 */
export function checkExpense(
  expense: ExpenseInput,
  claim: ClaimContext,
  pol: Policy,
  category: Category,
  sameDay: ExistingExpense[],
  allUserExp: ExistingExpense[],
): FlagCode[] {
  const flags: FlagCode[] = [];

  // ── OVER_ITEM_LIMIT ───────────────────────────────────────────────────────
  if (
    category.perItemLimitMinor !== null &&
    expense.amountMinor > category.perItemLimitMinor
  ) {
    flags.push('OVER_ITEM_LIMIT');
  }

  // ── OVER_DAY_LIMIT ────────────────────────────────────────────────────────
  if (category.perDayLimitMinor !== null) {
    const dayTotal =
      sameDay.reduce((sum, e) => sum + e.amountMinor, 0) + expense.amountMinor;
    if (dayTotal > category.perDayLimitMinor) {
      flags.push('OVER_DAY_LIMIT');
    }
  }

  // ── INVALID_GSTIN ─────────────────────────────────────────────────────────
  if (expense.gstin && !validateGSTIN(expense.gstin)) {
    flags.push('INVALID_GSTIN');
  }

  // ── MISSING_GSTIN ─────────────────────────────────────────────────────────
  if (
    expense.amountMinor > pol.gstinRequiredAboveMinor &&
    !expense.gstin
  ) {
    flags.push('MISSING_GSTIN');
  }

  // ── GST_MISMATCH ──────────────────────────────────────────────────────────
  if (expense.taxableMinor > 0 || expense.cgstMinor > 0 || expense.sgstMinor > 0 || expense.igstMinor > 0) {
    const gstSum =
      expense.taxableMinor +
      expense.cgstMinor +
      expense.sgstMinor +
      expense.igstMinor;
    if (!withinTolerance(gstSum, expense.amountMinor)) {
      flags.push('GST_MISMATCH');
    }
  }

  // ── WEEKEND ───────────────────────────────────────────────────────────────
  if (!pol.allowWeekendSpend && isWeekend(expense.date)) {
    flags.push('WEEKEND');
  }

  // ── OUTSIDE_TRIP ──────────────────────────────────────────────────────────
  if (isOutsideTrip(expense.date, claim.tripStart, claim.tripEnd)) {
    flags.push('OUTSIDE_TRIP');
  }

  // ── POSSIBLE_DUPLICATE ────────────────────────────────────────────────────
  const isDuplicate = allUserExp.some(
    (e) =>
      e.id !== expense.id &&
      e.date === expense.date &&
      e.merchant.toLowerCase() === expense.merchant.toLowerCase() &&
      e.amountMinor === expense.amountMinor,
  );
  if (isDuplicate) {
    flags.push('POSSIBLE_DUPLICATE');
  }

  return flags;
}

// ─────────────────────────────────────────────────────────────────────────────
// Submit-time check (adds MISSING_RECEIPT which is only relevant on submit)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Additional checks run only when the claim is submitted.
 * Returns the extra flags to add to each expense (keyed by expense id).
 */
export function checkSubmit(
  expenses: Array<ExpenseInput & { id: string }>,
  pol: Policy,
): Map<string, FlagCode[]> {
  const result = new Map<string, FlagCode[]>();

  for (const expense of expenses) {
    const extra: FlagCode[] = [];

    // ── MISSING_RECEIPT ────────────────────────────────────────────────────
    if (
      expense.amountMinor > pol.receiptRequiredAboveMinor &&
      !expense.receiptUrl
    ) {
      extra.push('MISSING_RECEIPT');
    }

    if (extra.length > 0) {
      result.set(expense.id, extra);
    }
  }

  return result;
}

