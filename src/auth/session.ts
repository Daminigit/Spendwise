/**
 * src/auth/session.ts
 *
 * Configures express-session and augments the Express Request type
 * so req.user is available everywhere.
 *
 * Store: Postgres (connect-pg-simple) when DATABASE_URL is set and we're not
 * running tests; otherwise the in-memory store.
 */

import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Request } from 'express';
import type { User } from '../db/schema.js';

export interface Flash {
  type: 'success' | 'error' | 'info';
  message: string;
}

// Extend the session data type
declare module 'express-session' {
  interface SessionData {
    userId: string;
    flash: Flash[];
    /** Raw MCP token shown exactly once after generation. */
    newToken: { id: string; url: string };
    /** Invite link shown once after generation. */
    inviteLink: { url: string; role: string; expiresAt: string };
  }
}

export interface SessionUser {
  id: string;
  orgId: string;
  role: User['role'];
  name: string;
  email: string;
  managerId: string | null;
}

// Extend Express Request so req.user is typed
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

function createStore(): session.Store | undefined {
  if (process.env.NODE_ENV === 'test' || !process.env.DATABASE_URL) return undefined;
  const PgStore = connectPgSimple(session);
  return new PgStore({
    conString: process.env.DATABASE_URL,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  });
}

export function createSessionMiddleware() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET env var is not set.');

  return session({
    name: 'sw.sid',
    secret,
    store: createStore(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  });
}

/** Start an authenticated session, regenerating the id to prevent fixation. */
export function logIn(req: Request, userId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.save((err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

export function logOut(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

export function flash(req: Request, type: Flash['type'], message: string) {
  req.session.flash = [...(req.session.flash ?? []), { type, message }];
}
