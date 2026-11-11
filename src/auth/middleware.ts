/**
 * src/auth/middleware.ts
 *
 * Route middleware: populateUser, requireAuth, requireRole.
 */

import type { Request, Response, NextFunction } from 'express';
import type { UserRole } from '../db/schema.js';
import { findUserById } from '../domain/org.js';

/**
 * Populate req.user from the session. The user row is re-read on every request
 * so role / manager changes by an admin take effect immediately.
 */
export async function populateUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const userId = req.session?.userId;
    if (userId) {
      const u = await findUserById(userId);
      if (u) {
        req.user = { id: u.id, orgId: u.orgId, role: u.role, name: u.name, email: u.email, managerId: u.managerId };
      } else {
        delete req.session.userId; // user was deleted
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Require a valid session; redirect to /login otherwise. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    if (req.method !== 'GET' || req.accepts(['html', 'json']) === 'json') {
      return res.status(401).json({ error: 'Not signed in.' });
    }
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

/** Require the user to have one of the given roles; return 403 otherwise. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('error', {
        title: 'Not allowed',
        code: 403,
        message: 'You do not have permission to access this page.',
      });
    }
    next();
  };
}
