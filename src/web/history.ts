/**
 * src/web/history.ts
 *
 * Turns a claim's audit entries into human-readable lines, shared by the claim
 * page and the MCP get_claim tool so people and Claude see the same history.
 */

import type { ClaimDetail } from '../domain/claims.js';
import { formatINR } from '../domain/money.js';
import { PAYMENT_METHODS, STATUS_LABELS } from './util.js';

export interface HistoryItem {
  at: Date;
  who: string;
  via: 'web' | 'claude';
  text: string;
  /** Line number (1-based) for line-level events. */
  line?: number;
  note?: string;
}

const str = (v: unknown) => (v == null || v === '' ? '—' : String(v));
const money = (v: unknown) => (typeof v === 'number' ? formatINR(v) : '—');
const pay = (v: unknown) => PAYMENT_METHODS.find((m) => m.value === v)?.label ?? str(v);

function describeChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  categoryName: (code: unknown) => string,
): { text: string[]; receipt: 'attached' | 'replaced' | null } {
  const text: string[] = [];
  let receipt: 'attached' | 'replaced' | null = null;
  const has = (k: string) => k in after;

  if (has('category') || has('categoryId')) {
    text.push(has('category') ? `category ${categoryName(before.category)} → ${categoryName(after.category)}` : 'category changed');
  }
  if (has('amountMinor')) text.push(`amount ${money(before.amountMinor)} → ${money(after.amountMinor)}`);
  if (has('date')) text.push(`date ${str(before.date)} → ${str(after.date)}`);
  if (has('merchant')) text.push(`merchant "${str(before.merchant)}" → "${str(after.merchant)}"`);
  if (has('gstin')) text.push(`GSTIN ${str(before.gstin)} → ${str(after.gstin)}`);
  if (['taxableMinor', 'cgstMinor', 'sgstMinor', 'igstMinor'].some(has)) text.push('GST breakdown');
  if (has('description')) text.push('description');
  if (has('paymentMethod')) text.push(`paid by ${pay(before.paymentMethod)} → ${pay(after.paymentMethod)}`);
  if (has('receiptUrl')) receipt = before.receiptUrl ? 'replaced' : 'attached';
  return { text, receipt };
}

export function describeHistory(claim: ClaimDetail, categoryNamesByCode: Record<string, string> = {}): HistoryItem[] {
  const lineNo = new Map(claim.expenses.map((e, i) => [e.id, i + 1]));
  const merchant = new Map(claim.expenses.map((e) => [e.id, e.merchant]));
  const categoryName = (code: unknown) => (typeof code === 'string' ? categoryNamesByCode[code] ?? code : '—');

  return claim.history.map((h) => {
    const before = (h.before ?? {}) as Record<string, unknown>;
    const after = (h.after ?? {}) as Record<string, unknown>;
    const base = { at: h.createdAt, who: h.actorName ?? 'Someone', via: h.actorVia === 'mcp' ? ('claude' as const) : ('web' as const) };

    if (h.entity === 'expense') {
      const n = lineNo.get(h.entityId);
      const label = n ? `line ${n} (${merchant.get(h.entityId)})` : 'a line';
      const note = typeof after.note === 'string' && after.note ? after.note : undefined;
      switch (h.action) {
        case 'approve':
          return { ...base, line: n, note, text: `Approved ${label}` };
        case 'reject':
          return { ...base, line: n, note, text: `Rejected ${label}` };
        case 'update': {
          const { text, receipt } = describeChanges(before, after, categoryName);
          if (text.length === 0 && receipt) return { ...base, line: n, text: `${receipt === 'attached' ? 'Attached' : 'Replaced'} the receipt on ${label}` };
          const parts = receipt ? [...text, `${receipt} the receipt`] : text;
          return { ...base, line: n, text: parts.length ? `Edited ${label}: ${parts.join('; ')}` : `Edited ${label}` };
        }
        default:
          return { ...base, line: n, text: `${h.action} ${label}` };
      }
    }

    switch (h.action) {
      case 'create': {
        const count = typeof after.expenseCount === 'number' ? after.expenseCount : null;
        return { ...base, text: count ? `Created the claim with ${count} line${count === 1 ? '' : 's'}` : 'Created the claim' };
      }
      case 'add_expenses': {
        const count = typeof after.count === 'number' ? after.count : 0;
        return { ...base, text: `Added ${count} line${count === 1 ? '' : 's'}` };
      }
      case 'submit':
        return { ...base, text: 'Submitted for approval' };
      case 'decide':
        return { ...base, text: `Decided: ${STATUS_LABELS[String(after.status)] ?? str(after.status)}` };
      case 'mark_paid':
        return { ...base, text: 'Marked as paid' };
      default:
        return { ...base, text: h.action };
    }
  });
}
