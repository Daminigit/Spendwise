/**
 * src/web/util.ts
 *
 * Small helpers shared by web routes: async wrapper, form parsing, view helpers.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import { formatINR, toPaise, toRupees } from '../domain/money.js';

/** Wrap an async handler so rejections reach the Express error handler. */
export function ah(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Throw a DomainError('invalid') with the first zod issue, readable for humans. */
export function parseForm<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.');
    throw new DomainError(field ? `${field}: ${issue.message}` : issue.message, 'invalid');
  }
  return result.data;
}

/** Only allow same-site relative redirects (no `//evil.com`, no scheme). */
export function safeNext(next: unknown, fallback = '/claims'): string {
  if (typeof next !== 'string') return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}

// ── Zod form primitives ──────────────────────────────────────────────────────

const trimmed = z.string().trim();

/** Empty string → undefined. */
export const optionalText = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

export const requiredText = (label: string, max = 200) =>
  trimmed.min(1, `${label} is required`).max(max, `${label} is too long`);

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');

export const optionalIsoDate = z
  .string()
  .optional()
  .transform((v) => (v ? v.trim() : ''))
  .pipe(z.union([z.literal(''), isoDate]))
  .transform((v) => (v === '' ? undefined : v));

/** Parse a rupee amount typed by a human ("1,234.50", "₹ 500") → number of rupees. */
export const rupees = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const s = String(v).replace(/[₹,\s]/g, '');
    if (s === '') return 0;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be an amount like 1250.50' });
      return z.NEVER;
    }
    return Number(s);
  });

/** Like `rupees`, but blank → null (used for optional limits). Returns paise. */
export const optionalLimitPaise = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v, ctx) => {
    const s = v === undefined ? '' : String(v).replace(/[₹,\s]/g, '');
    if (s === '') return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be an amount like 1500 or blank' });
      return z.NEVER;
    }
    return toPaise(Number(s));
  });

export const checkbox = z
  .union([z.string(), z.array(z.string()), z.boolean()])
  .optional()
  .transform((v) => (Array.isArray(v) ? v.includes('on') || v.includes('true') : v === true || v === 'on' || v === 'true'));

/** Normalise a body field that may be a single value, array, or object of rows into an array. */
export function asArray<T>(v: T | T[] | Record<string, T> | undefined): T[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return Object.values(v as Record<string, T>);
  return [v];
}

// ── View helpers (exposed as res.locals / app.locals) ────────────────────────

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  partially_approved: 'Partly approved',
  rejected: 'Rejected',
  paid: 'Paid',
  pending: 'Pending',
};

export const FLAG_LABELS: Record<string, string> = {
  OVER_ITEM_LIMIT: 'Over item limit',
  OVER_DAY_LIMIT: 'Over daily limit',
  MISSING_RECEIPT: 'Missing receipt',
  MISSING_GSTIN: 'Missing GSTIN',
  INVALID_GSTIN: 'Invalid GSTIN',
  GST_MISMATCH: 'GST mismatch',
  WEEKEND: 'Weekend',
  OUTSIDE_TRIP: 'Outside trip dates',
  POSSIBLE_DUPLICATE: 'Possible duplicate',
};

export const PAYMENT_METHODS = [
  { value: 'personal_card', label: 'Personal card' },
  { value: 'upi', label: 'UPI' },
  { value: 'cash', label: 'Cash' },
  { value: 'company_card', label: 'Company card' },
] as const;

export const viewHelpers = {
  formatINR,
  /** Paise → plain rupee string for form inputs ("1250.50"). */
  rupeeInput: (paise: number | null | undefined) => (paise == null ? '' : toRupees(paise).toFixed(2)),
  statusLabel: (s: string) => STATUS_LABELS[s] ?? s,
  flagLabel: (f: string) => FLAG_LABELS[f] ?? f,
  formatDate: (d: Date | string | null | undefined) => {
    if (!d) return '—';
    const date = typeof d === 'string' ? new Date(`${d}T00:00:00`) : d;
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  },
  formatDateTime: (d: Date | null | undefined) =>
    d ? d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
  PAYMENT_METHODS,
  FLAG_LABELS,
};
