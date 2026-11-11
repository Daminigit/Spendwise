/**
 * GET  /claims                 my claims (filter by status)
 * POST /claims                 new draft from the web
 * GET  /claims/:id             detail
 * POST /claims/:id/edit        save edited lines
 * POST /claims/:id/lines       add a line (draft owner)
 * POST /claims/:id/submit
 * POST /claims/:id/comments
 * POST /claims/:id/mark-paid   admin
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { flash } from '../../auth/session.js';
import {
  addComment,
  addExpenses,
  createClaim,
  getClaim,
  listClaims,
  markPaid,
  submitClaim,
  updateExpense,
  type ClaimDetail,
  type ExpenseInputRaw,
} from '../../domain/claims.js';
import { DomainError } from '../../domain/errors.js';
import { findUserById, getPolicy } from '../../domain/org.js';
import { toPaise } from '../../domain/money.js';
import type { ClaimStatus } from '../../db/schema.js';
import { ah, asArray, isoDate, optionalIsoDate, optionalText, parseForm, requiredText, rupees } from '../util.js';

export const claimsRouter = Router();
claimsRouter.use('/claims', requireAuth);

const CLAIM_STATUSES: ClaimStatus[] = ['draft', 'submitted', 'approved', 'partially_approved', 'rejected', 'paid'];
const PAYMENT_METHOD = z.enum(['personal_card', 'cash', 'upi', 'company_card']);

const lineSchema = z.object({
  date: isoDate,
  merchant: requiredText('Merchant', 200),
  category: requiredText('Category', 100),
  description: z.string().trim().max(500).optional().default(''),
  amount: rupees.refine((v) => v > 0, 'must be more than zero'),
  gstin: z.string().trim().max(20).optional().default(''),
  taxable_amount: rupees.optional().default(0),
  cgst: rupees.optional().default(0),
  sgst: rupees.optional().default(0),
  igst: rupees.optional().default(0),
  payment_method: PAYMENT_METHOD.optional().default('personal_card'),
});

/**
 * Editing an existing line: every field is optional and an ABSENT field means
 * "unchanged" (no defaults — a partial post must never zero GST amounts).
 */
const editLineSchema = z.object({
  date: isoDate.optional(),
  merchant: requiredText('Merchant', 200).optional(),
  category: requiredText('Category', 100).optional(),
  description: z.string().trim().max(500).optional(),
  amount: rupees.refine((v) => v > 0, 'must be more than zero').optional(),
  gstin: z.string().trim().max(20).optional(),
  taxable_amount: rupees.optional(),
  cgst: rupees.optional(),
  sgst: rupees.optional(),
  igst: rupees.optional(),
  payment_method: PAYMENT_METHOD.optional(),
});

// ── Permission summary for the detail view ───────────────────────────────────

async function permissionsFor(req: Request, claim: ClaimDetail) {
  const me = req.user!;
  const isOwner = claim.userId === me.id;
  let isApprover = false;
  if (claim.status === 'submitted') {
    if (me.role === 'admin') isApprover = true;
    else if (me.role === 'manager') isApprover = (await findUserById(claim.userId))?.managerId === me.id;
  }
  return {
    isOwner,
    canEdit: (isOwner && claim.status === 'draft') || isApprover,
    canAddLines: isOwner && claim.status === 'draft',
    canSubmit: isOwner && claim.status === 'draft' && claim.expenses.length > 0,
    canDecide: isApprover,
    canMarkPaid: me.role === 'admin' && (claim.status === 'approved' || claim.status === 'partially_approved'),
  };
}

// ── List ─────────────────────────────────────────────────────────────────────

claimsRouter.get(
  '/claims',
  ah(async (req, res) => {
    const status = CLAIM_STATUSES.includes(req.query.status as ClaimStatus) ? (req.query.status as ClaimStatus) : undefined;
    const list = await listClaims(req.user!.id, { status });
    res.render('claims/list', { title: 'My claims', claims: list, status: status ?? '', statuses: CLAIM_STATUSES });
  }),
);

claimsRouter.post(
  '/claims',
  ah(async (req, res) => {
    const input = parseForm(
      z.object({
        title: requiredText('Title', 200),
        purpose: optionalText,
        trip_start: optionalIsoDate,
        trip_end: optionalIsoDate,
      }),
      req.body,
    );
    if (input.trip_start && input.trip_end && input.trip_end < input.trip_start) {
      flash(req, 'error', 'Trip end must be on or after trip start.');
      return res.redirect(303, '/claims');
    }
    const result = await createClaim(req.user!.id, req.user!.orgId, { ...input, expenses: [] }, 'web');
    flash(req, 'success', 'Draft created. Add your expense lines below.');
    res.redirect(303, `/claims/${result.claimId}`);
  }),
);

// ── Detail ───────────────────────────────────────────────────────────────────

claimsRouter.get(
  '/claims/:id',
  ah(async (req, res) => {
    const claim = await getClaim(String(req.params.id), req.user!.id);
    const { categories } = await getPolicy(claim.orgId);
    const perms = await permissionsFor(req, claim);
    res.render('claims/detail', {
      title: claim.title,
      claim,
      categories: categories.filter((c) => c.active || claim.expenses.some((e) => e.categoryId === c.id)),
      perms,
      today: new Date().toISOString().slice(0, 10),
    });
  }),
);

// ── Edit lines ───────────────────────────────────────────────────────────────

claimsRouter.post(
  '/claims/:id/edit',
  ah(async (req, res) => {
    const claim = await getClaim(String(req.params.id), req.user!.id);
    const rows = asArray(req.body.lines as Record<string, unknown> | undefined);

    let changed = 0;
    for (const row of rows) {
      const id = typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id : '';
      const existing = claim.expenses.find((e) => e.id === id);
      if (!existing) continue; // ignore unknown ids rather than touching other claims
      const line = parseForm(editLineSchema, row);

      // receipt_url is never taken from the form; only POST /upload/receipt sets it
      const fields: Partial<ExpenseInputRaw> = {};
      const moneyChanged = (v: number | undefined, current: number) => v !== undefined && toPaise(v) !== current;
      if (line.date !== undefined && line.date !== existing.date) fields.date = line.date;
      if (line.merchant !== undefined && line.merchant !== existing.merchant) fields.merchant = line.merchant;
      if (line.category !== undefined && line.category.toUpperCase() !== existing.categoryCode.toUpperCase()) {
        fields.category = line.category.toUpperCase();
      }
      if (line.description !== undefined && line.description !== existing.description) fields.description = line.description;
      if (moneyChanged(line.amount, existing.amountMinor)) fields.amount = line.amount;
      if (line.gstin !== undefined && (line.gstin.toUpperCase() || null) !== (existing.gstin || null)) fields.gstin = line.gstin;
      if (moneyChanged(line.taxable_amount, existing.taxableMinor)) fields.taxable_amount = line.taxable_amount;
      if (moneyChanged(line.cgst, existing.cgstMinor)) fields.cgst = line.cgst;
      if (moneyChanged(line.sgst, existing.sgstMinor)) fields.sgst = line.sgst;
      if (moneyChanged(line.igst, existing.igstMinor)) fields.igst = line.igst;
      if (line.payment_method !== undefined && line.payment_method !== existing.paymentMethod) {
        fields.payment_method = line.payment_method;
      }

      if (Object.keys(fields).length === 0) continue;
      await updateExpense(existing.id, req.user!.id, fields, 'web');
      changed++;
    }

    flash(req, changed ? 'success' : 'info', changed ? `Saved ${changed} line${changed === 1 ? '' : 's'}.` : 'No changes to save.');
    res.redirect(303, `/claims/${claim.id}`);
  }),
);

claimsRouter.post(
  '/claims/:id/lines',
  ah(async (req, res) => {
    const line = parseForm(lineSchema, req.body);
    await addExpenses(
      String(req.params.id),
      req.user!.id,
      [{ ...line, gstin: line.gstin ? line.gstin.toUpperCase() : undefined }],
      'web',
    );
    flash(req, 'success', 'Line added.');
    res.redirect(303, `/claims/${String(req.params.id)}`);
  }),
);

// ── Submit / comment / pay ───────────────────────────────────────────────────

claimsRouter.post(
  '/claims/:id/submit',
  ah(async (req, res) => {
    const result = await submitClaim(String(req.params.id), req.user!.id, 'web');
    flash(req, 'success', result.approverName ? `Submitted to ${result.approverName} for approval.` : 'Submitted for approval.');
    res.redirect(303, `/claims/${String(req.params.id)}`);
  }),
);

claimsRouter.post(
  '/claims/:id/comments',
  ah(async (req, res) => {
    const { body } = parseForm(z.object({ body: requiredText('Comment', 2000) }), req.body);
    await getClaim(String(req.params.id), req.user!.id); // access check
    await addComment(String(req.params.id), req.user!.id, body, 'web');
    res.redirect(303, `/claims/${String(req.params.id)}#comments`);
  }),
);

claimsRouter.post(
  '/claims/:id/mark-paid',
  requireRole('admin'),
  ah(async (req, res) => {
    const paid = await markPaid([String(req.params.id)], req.user!.id, 'web');
    if (paid.length === 0) throw new DomainError('Only approved claims in your organisation can be marked as paid.', 'invalid');
    flash(req, 'success', 'Marked as paid.');
    res.redirect(303, `/claims/${String(req.params.id)}`);
  }),
);
