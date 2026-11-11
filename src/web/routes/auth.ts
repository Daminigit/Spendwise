/**
 * GET/POST /signup, GET/POST /login, POST /logout
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { flash, logIn, logOut } from '../../auth/session.js';
import { dummyVerify, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../../auth/password.js';
import { DomainError } from '../../domain/errors.js';
import { findUserByEmail, getOrganisation, signupWithInvite, signupWithNewOrg, verifyInvite } from '../../domain/org.js';
import { ah, requiredText, safeNext } from '../util.js';

export const authRouter = Router();

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(200);
const password = z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`).max(200);

// ── Login ────────────────────────────────────────────────────────────────────

authRouter.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render('auth/login', { title: 'Log in', next: safeNext(req.query.next), email: '', error: null });
});

authRouter.post(
  '/login',
  ah(async (req, res) => {
    const next = safeNext(req.body.next);
    const parsed = z.object({ email, password: z.string().min(1).max(200) }).safeParse(req.body);
    const renderError = (msg: string) =>
      res.status(400).render('auth/login', { title: 'Log in', next, email: String(req.body.email ?? ''), error: msg });

    if (!parsed.success) return renderError('Enter your email and password.');

    const user = await findUserByEmail(parsed.data.email);
    const ok = user ? await verifyPassword(user.passwordHash, parsed.data.password) : await dummyVerify(parsed.data.password);
    if (!user || !ok) return renderError('Email or password is incorrect.');

    await logIn(req, user.id);
    res.redirect(303, next);
  }),
);

// ── Signup ───────────────────────────────────────────────────────────────────

async function signupLocals(req: Request) {
  const inviteToken = typeof req.query.invite === 'string' ? req.query.invite : typeof req.body?.invite === 'string' ? req.body.invite : '';
  const invite = inviteToken ? verifyInvite(inviteToken) : null;
  const org = invite ? await getOrganisation(invite.orgId) : undefined;
  return { inviteToken, invite, orgName: org?.name ?? null, inviteInvalid: Boolean(inviteToken) && !org };
}

authRouter.get(
  '/signup',
  ah(async (req, res) => {
    if (req.user) return res.redirect('/claims');
    res.render('auth/signup', { title: 'Sign up', ...(await signupLocals(req)), form: {}, error: null });
  }),
);

authRouter.post(
  '/signup',
  ah(async (req: Request, res: Response) => {
    const locals = await signupLocals(req);
    const renderError = (msg: string) =>
      res.status(400).render('auth/signup', {
        title: 'Sign up',
        ...locals,
        form: { name: req.body.name ?? '', email: req.body.email ?? '', orgName: req.body.orgName ?? '' },
        error: msg,
      });

    if (locals.inviteInvalid) return renderError('This invite link is invalid or has expired. Ask your admin for a new one.');

    const schema = z.object({
      name: requiredText('Your name', 100),
      email,
      password,
      orgName: locals.invite ? z.any().optional() : requiredText('Company name', 120),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return renderError(parsed.error.issues[0].message);

    const passwordHash = await hashPassword(parsed.data.password);
    try {
      const user = locals.invite
        ? await signupWithInvite(locals.invite, { name: parsed.data.name, email: parsed.data.email, passwordHash })
        : await signupWithNewOrg({ orgName: String(parsed.data.orgName), name: parsed.data.name, email: parsed.data.email, passwordHash });
      await logIn(req, user.id);
      flash(req, 'success', locals.invite ? `Welcome to ${locals.orgName}!` : 'Your organisation is ready. Next: connect Claude.');
      res.redirect(303, locals.invite ? '/claims' : '/settings/connect');
    } catch (err) {
      if (err instanceof DomainError) return renderError(err.message);
      throw err;
    }
  }),
);

// ── Logout ───────────────────────────────────────────────────────────────────

authRouter.post(
  '/logout',
  ah(async (req, res) => {
    await logOut(req);
    res.clearCookie('sw.sid');
    res.redirect(303, '/');
  }),
);
