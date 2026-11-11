/**
 * GET/POST /settings/policy    everyone can read; admins edit policy + categories
 * GET/POST /settings/team      admin: members, roles, managers, invite links
 * GET/POST /settings/connect   everyone: MCP tokens + "Add to Claude" steps
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { flash } from '../../auth/session.js';
import { DomainError } from '../../domain/errors.js';
import { createInvite, getPolicy, listTeam, updateMember, upsertCategories, updatePolicy } from '../../domain/org.js';
import { createToken, listTokens, revokeToken } from '../../domain/tokens.js';
import { toPaise } from '../../domain/money.js';
import { appUrl } from '../../config.js';
import { ah, asArray, checkbox, optionalLimitPaise, parseForm, requiredText, rupees } from '../util.js';

export const settingsRouter = Router();
settingsRouter.use('/settings', requireAuth);

settingsRouter.get('/settings', (_req, res) => res.redirect('/settings/connect'));

// ── Policy ───────────────────────────────────────────────────────────────────

settingsRouter.get(
  '/settings/policy',
  ah(async (req, res) => {
    const { policy, categories } = await getPolicy(req.user!.orgId);
    res.render('settings/policy', { title: 'Policy', policy, categories, canEdit: req.user!.role === 'admin' });
  }),
);

const policySchema = z.object({
  receiptRequiredAbove: rupees,
  gstinRequiredAbove: rupees,
  allowWeekendSpend: checkbox,
  notes: z.string().max(5000).optional().default(''),
});

const categorySchema = z.object({
  id: z.string().optional().transform((v) => (v ? v : undefined)),
  name: z.string().trim().max(100),
  code: z.string().trim().max(20),
  perItemLimit: optionalLimitPaise,
  perDayLimit: optionalLimitPaise,
  active: checkbox,
});

settingsRouter.post(
  '/settings/policy',
  requireRole('admin'),
  ah(async (req, res) => {
    if (req.body.form === 'categories') {
      const rows = asArray(req.body.categories as Record<string, unknown> | undefined)
        .map((r) => parseForm(categorySchema, r))
        // A blank "new category" row is simply ignored
        .filter((r) => r.id || r.name || r.code);
      for (const r of rows) {
        if (!r.name) throw new DomainError('Every category needs a name.', 'invalid');
        if (!/^[A-Za-z0-9_]{2,20}$/.test(r.code)) {
          throw new DomainError(`Category code '${r.code}' must be 2–20 letters, digits or underscores.`, 'invalid');
        }
      }
      await upsertCategories(
        req.user!.id,
        rows.map((r) => ({ id: r.id, name: r.name, code: r.code, perItemLimitMinor: r.perItemLimit, perDayLimitMinor: r.perDayLimit, active: r.active })),
        'web',
      );
      flash(req, 'success', 'Categories saved.');
    } else {
      const p = parseForm(policySchema, req.body);
      await updatePolicy(
        req.user!.id,
        {
          receiptRequiredAboveMinor: toPaise(p.receiptRequiredAbove),
          gstinRequiredAboveMinor: toPaise(p.gstinRequiredAbove),
          allowWeekendSpend: p.allowWeekendSpend,
          notes: p.notes,
        },
        'web',
      );
      flash(req, 'success', 'Policy saved.');
    }
    res.redirect(303, '/settings/policy');
  }),
);

// ── Team ─────────────────────────────────────────────────────────────────────

settingsRouter.get(
  '/settings/team',
  requireRole('admin'),
  ah(async (req, res) => {
    const members = await listTeam(req.user!.orgId);
    const inviteLink = req.session.inviteLink ?? null;
    delete req.session.inviteLink;
    res.render('settings/team', { title: 'Team', members, inviteLink });
  }),
);

const ROLE = z.enum(['employee', 'manager', 'admin']);

settingsRouter.post(
  '/settings/team',
  requireRole('admin'),
  ah(async (req, res) => {
    const managerId = z
      .string()
      .optional()
      .transform((v) => (v ? v : null));

    if (req.body.action === 'invite') {
      const input = parseForm(z.object({ role: ROLE, managerId }), req.body);
      const { token, expiresAt } = await createInvite(req.user!.id, input.role, input.managerId);
      const base = appUrl();
      req.session.inviteLink = { url: `${base}/signup?invite=${encodeURIComponent(token)}`, role: input.role, expiresAt: expiresAt.toISOString() };
      return res.redirect(303, '/settings/team#invite');
    }

    const input = parseForm(z.object({ memberId: requiredText('Member'), role: ROLE, managerId }), req.body);
    await updateMember(req.user!.id, input.memberId, { role: input.role, managerId: input.managerId }, 'web');
    flash(req, 'success', 'Member updated.');
    res.redirect(303, '/settings/team');
  }),
);

// ── Connect Claude ───────────────────────────────────────────────────────────

settingsRouter.get(
  '/settings/connect',
  ah(async (req, res) => {
    const tokens = await listTokens(req.user!.id);
    const newToken = req.session.newToken ?? null;
    delete req.session.newToken; // raw token is shown exactly once
    res.setHeader('Cache-Control', 'no-store');
    res.render('settings/connect', { title: 'Connect Claude', tokens, newToken });
  }),
);

settingsRouter.post(
  '/settings/connect',
  ah(async (req, res) => {
    if (req.body.action === 'revoke') {
      const { tokenId } = parseForm(z.object({ tokenId: requiredText('Token') }), req.body);
      await revokeToken(req.user!.id, tokenId);
      flash(req, 'success', 'Token revoked. Claude can no longer use that connector URL.');
      return res.redirect(303, '/settings/connect');
    }
    const { label } = parseForm(z.object({ label: z.string().trim().max(60).optional().default('') }), req.body);
    const created = await createToken(req.user!.id, label || 'Claude');
    req.session.newToken = { id: created.id, url: created.url };
    res.redirect(303, '/settings/connect#new-token');
  }),
);
