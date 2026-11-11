/**
 * src/mcp/util.ts
 *
 * Shared pieces for MCP tools: the per-request context, input schemas,
 * result helpers and presenters that turn paise into rupees for Claude.
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { User } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';
import { formatINR, toRupees } from '../domain/money.js';
import type { ClaimDetail, ClaimSummary, ClaimTotals } from '../domain/claims.js';
import { FLAG_LABELS } from '../web/util.js';

/** Who is calling: the user that owns the connector token. */
export interface McpContext {
  user: User;
}

// ── Input schemas ────────────────────────────────────────────────────────────

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO format YYYY-MM-DD, e.g. 2026-11-03');

const money = (what: string) =>
  z
    .number({ invalid_type_error: `${what} must be a number in rupees, e.g. 2360.00 (not a string, not paise)` })
    .nonnegative(`${what} cannot be negative`)
    .max(100_000_000, `${what} looks too large; send rupees, not paise`);

export const dateField = isoDate;

export const expenseInput = z.object({
  date: isoDate.describe('Date on the receipt, YYYY-MM-DD'),
  merchant: z.string().trim().min(1, 'merchant is required').max(200).describe('Merchant name as printed on the receipt'),
  category: z
    .string()
    .trim()
    .min(1)
    .describe('Category name or code exactly as returned by get_policy (e.g. "Meals" or "MEALS")'),
  description: z.string().max(500).optional().describe('Short business purpose for this line'),
  amount: money('amount').positive('amount must be more than zero').describe('Total paid incl. GST, in rupees (major units)'),
  currency: z
    .literal('INR', { errorMap: () => ({ message: 'Only INR is supported in v1. Convert foreign amounts to INR first.' }) })
    .optional()
    .describe('Always "INR" in v1'),
  gstin: z.string().trim().max(20).optional().describe("Supplier's 15-character GSTIN, if printed on the receipt"),
  taxable_amount: money('taxable_amount').optional().describe('Taxable value before GST, in rupees'),
  cgst: money('cgst').optional().describe('CGST in rupees (intra-state)'),
  sgst: money('sgst').optional().describe('SGST/UTGST in rupees (intra-state)'),
  igst: money('igst').optional().describe('IGST in rupees (inter-state)'),
  payment_method: z
    .enum(['personal_card', 'cash', 'upi', 'company_card'])
    .optional()
    .describe('How the employee paid; default personal_card'),
});

export type ExpenseInput = z.infer<typeof expenseInput>;

/** Normalise fields Claude sends before they reach the domain layer. */
export function toDomainExpense(e: ExpenseInput) {
  return { ...e, gstin: e.gstin ? e.gstin.toUpperCase() : undefined, currency: 'INR' };
}

// ── Presenters (paise → rupees) ──────────────────────────────────────────────

export const rupees = (paise: number) => toRupees(paise);

export function presentTotals(t: ClaimTotals) {
  const gst = t.cgstMinor + t.sgstMinor + t.igstMinor;
  return {
    gross: rupees(t.grossMinor),
    gross_formatted: formatINR(t.grossMinor),
    taxable: rupees(t.taxableMinor),
    gst: rupees(gst),
    cgst: rupees(t.cgstMinor),
    sgst: rupees(t.sgstMinor),
    igst: rupees(t.igstMinor),
  };
}

export function presentFlags(flags: string[]) {
  return flags.map((code) => ({ code, label: FLAG_LABELS[code] ?? code }));
}

export function claimUrl(claimId: string) {
  return `${(process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/claims/${claimId}`;
}

export function presentSummary(c: ClaimSummary) {
  return {
    claim_id: c.id,
    title: c.title,
    status: c.status,
    total: rupees(c.totalMinor),
    total_formatted: formatINR(c.totalMinor),
    lines: c.expenseCount,
    flags: c.flagCount,
    source: c.source,
    submitted_at: c.submittedAt?.toISOString() ?? null,
    created_at: c.createdAt.toISOString(),
    ...(c.user ? { employee: { name: c.user.name, email: c.user.email } } : {}),
    app_url: claimUrl(c.id),
  };
}

export function presentLine(e: ClaimDetail['expenses'][number]) {
  return {
    expense_id: e.id,
    date: e.date,
    merchant: e.merchant,
    category: e.categoryName,
    category_code: e.categoryCode,
    description: e.description,
    amount: rupees(e.amountMinor),
    currency: e.currency,
    gstin: e.gstin,
    taxable_amount: rupees(e.taxableMinor),
    cgst: rupees(e.cgstMinor),
    sgst: rupees(e.sgstMinor),
    igst: rupees(e.igstMinor),
    payment_method: e.paymentMethod,
    has_receipt: Boolean(e.receiptUrl),
    status: e.status,
    reviewer_note: e.reviewerNote,
    flags: presentFlags(e.flags),
  };
}

export function presentClaim(c: ClaimDetail) {
  return {
    claim_id: c.id,
    title: c.title,
    purpose: c.purpose,
    trip_start: c.tripStart,
    trip_end: c.tripEnd,
    status: c.status,
    source: c.source,
    employee: { name: c.user.name, email: c.user.email },
    submitted_at: c.submittedAt?.toISOString() ?? null,
    decided_at: c.decidedAt?.toISOString() ?? null,
    paid_at: c.paidAt?.toISOString() ?? null,
    totals: presentTotals(c.totals),
    lines: c.expenses.map(presentLine),
    comments: c.comments.map((m) => ({ by: m.userName, at: m.createdAt.toISOString(), body: m.body })),
    history: c.history.map((h) => ({
      action: h.action,
      via: h.actorVia === 'mcp' ? 'claude' : 'web',
      at: h.createdAt.toISOString(),
      ...(h.after && 'status' in h.after ? { status: h.after.status } : {}),
    })),
    app_url: claimUrl(c.id),
  };
}

// ── Results ──────────────────────────────────────────────────────────────────

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * Run a tool body, turning DomainErrors into clear tool errors Claude can act
 * on. Unexpected errors are logged and reported generically (never leak internals).
 */
export async function run(tool: string, fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof DomainError) return toolError(err.message);
    console.error(`[mcp:${tool}]`, err);
    return toolError(`Spendwise hit an unexpected error running ${tool}. Please try again in a moment.`);
  }
}
