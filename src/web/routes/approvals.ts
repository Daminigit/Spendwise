/**
 * GET  /approvals                 queue (oldest first) + admin "awaiting payment"
 * POST /approvals/:id/decide      per-line approve / reject
 * POST /approvals/mark-paid       admin bulk mark-as-paid
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../auth/middleware.js';
import { flash } from '../../auth/session.js';
import { decideClaim, getClaim, listAwaitingPayment, listPendingApprovals, markPaid } from '../../domain/claims.js';
import { DomainError } from '../../domain/errors.js';
import { ah, asArray, parseForm } from '../util.js';

export const approvalsRouter = Router();
approvalsRouter.use('/approvals', requireRole('manager', 'admin'));

approvalsRouter.get(
  '/approvals',
  ah(async (req, res) => {
    const pending = await listPendingApprovals(req.user!.id);
    const awaitingPayment = req.user!.role === 'admin' ? await listAwaitingPayment(req.user!.id) : [];
    res.render('approvals/list', { title: 'Approvals', pending, awaitingPayment });
  }),
);

const decideSchema = z.object({
  action: z.enum(['approve_all', 'apply']).default('apply'),
  note: z.string().trim().max(1000).optional(),
  decisions: z.record(z.enum(['approve', 'reject'])).optional().default({}),
  notes: z.record(z.string().trim().max(1000)).optional().default({}),
});

approvalsRouter.post(
  '/approvals/:id/decide',
  ah(async (req, res) => {
    const input = parseForm(decideSchema, req.body);
    const claim = await getClaim(String(req.params.id), req.user!.id);

    if (input.action === 'approve_all') {
      const result = await decideClaim(claim.id, req.user!.id, [], true, input.note || undefined, 'web');
      flash(req, 'success', `Claim ${result.newStatus === 'approved' ? 'approved' : 'updated'}.`);
      return res.redirect(303, '/approvals');
    }

    // Every line needs a decision, otherwise the claim would be stuck half-decided.
    const missing = claim.expenses.filter((e) => !input.decisions[e.id]);
    if (missing.length > 0) {
      throw new DomainError(`Choose approve or reject for every line (${missing.length} left).`, 'invalid');
    }
    const rejectedWithoutNote = claim.expenses.filter((e) => input.decisions[e.id] === 'reject' && !input.notes[e.id]);
    if (rejectedWithoutNote.length > 0) {
      throw new DomainError('Add a note explaining each rejected line.', 'invalid');
    }

    const decisions = claim.expenses.map((e) => ({
      expenseId: e.id,
      approve: input.decisions[e.id] === 'approve',
      note: input.notes[e.id] || undefined,
    }));
    const result = await decideClaim(claim.id, req.user!.id, decisions, false, input.note || undefined, 'web');
    const label = { approved: 'approved', rejected: 'rejected', partially_approved: 'partly approved' }[result.newStatus as string] ?? 'updated';
    flash(req, 'success', `Claim ${label}.`);
    res.redirect(303, '/approvals');
  }),
);

approvalsRouter.post(
  '/approvals/mark-paid',
  requireRole('admin'),
  ah(async (req, res) => {
    const ids = parseForm(z.array(z.string().min(1)).min(1, 'Select at least one claim'), asArray(req.body.ids));
    const paid = await markPaid(ids, req.user!.id, 'web');
    const skipped = ids.length - paid.length;
    flash(
      req,
      paid.length ? 'success' : 'error',
      `Marked ${paid.length} claim${paid.length === 1 ? '' : 's'} as paid.` +
        (skipped ? ` ${skipped} skipped (not approved, or already paid).` : ''),
    );
    res.redirect(303, '/approvals');
  }),
);
