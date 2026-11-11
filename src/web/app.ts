/**
 * src/web/app.ts
 *
 * Builds the Express app (no listen) so tests can mount it directly.
 */

import path from 'path';
import express, { type ErrorRequestHandler, type Request } from 'express';
import ejs from 'ejs';
import multer from 'multer';
import { createSessionMiddleware } from '../auth/session.js';
import { populateUser, requireAuth } from '../auth/middleware.js';
import { DomainError, httpStatusFor } from '../domain/errors.js';
import { createMcpRouter } from '../mcp/server.js';
import { viewHelpers } from './util.js';
import { authRouter } from './routes/auth.js';
import { homeRouter } from './routes/home.js';
import { claimsRouter } from './routes/claims.js';
import { approvalsRouter } from './routes/approvals.js';
import { reportsRouter } from './routes/reports.js';
import { settingsRouter } from './routes/settings.js';
import { uploadRouter } from './routes/upload.js';

// Resolved from the working directory so it works for both `tsx src/…` and
// `node dist/…` (the Dockerfile copies src/web/{views,public} next to dist/).
const WEB_DIR = path.resolve('src/web');
const VIEWS_DIR = path.join(WEB_DIR, 'views');
const LAYOUT = path.join(VIEWS_DIR, 'layout.ejs');

/**
 * EJS engine that wraps every view in layout.ejs (pass `layout: false` to skip).
 * The view's HTML is available to the layout as `body`.
 */
function layoutEngine(
  filePath: string,
  options: object,
  callback: (e: unknown, rendered?: string) => void,
) {
  const opts = options as Record<string, unknown>;
  ejs.renderFile(filePath, opts, (err, body) => {
    if (err) return callback(err);
    if (opts.layout === false || filePath === LAYOUT) return callback(null, body);
    ejs.renderFile(LAYOUT, { ...opts, body }, callback);
  });
}

/** Reject cross-site form posts: if Origin is sent it must match our host. */
function sameOrigin(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true; // same-origin navigations from older browsers / curl
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

function wantsJson(req: Request): boolean {
  return req.path.startsWith('/upload') || req.xhr || req.accepts(['html', 'json']) === 'json';
}

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // Render / Fly terminate TLS in front of us
  app.disable('x-powered-by');
  app.engine('ejs', layoutEngine);
  app.set('view engine', 'ejs');
  app.set('views', VIEWS_DIR);
  Object.assign(app.locals, viewHelpers, { appName: 'Spendwise' });

  // Health check (no session / DB work)
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/public', express.static(path.join(WEB_DIR, 'public'), { maxAge: '1h' }));

  // MCP lives outside the cookie session: it authenticates by URL token.
  app.use('/mcp', express.json({ limit: '4mb' }), createMcpRouter());

  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(createSessionMiddleware());
  app.use(populateUser);

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      return res.status(403).send('Cross-site request blocked.');
    }
    // Locals available to every view
    res.locals.user = req.user ?? null;
    res.locals.currentPath = req.path;
    res.locals.flash = req.session?.flash ?? [];
    res.locals.title = 'Spendwise';
    if (req.session) req.session.flash = [];
    next();
  });

  // Local receipt files (dev only — prod uses S3/R2). Signed-in users only.
  if (!process.env.S3_ENDPOINT) {
    app.use('/uploads', requireAuth, express.static(path.resolve('uploads'), { fallthrough: false }));
  }

  app.use(homeRouter);
  app.use(authRouter);
  app.use(claimsRouter);
  app.use(approvalsRouter);
  app.use(reportsRouter);
  app.use(settingsRouter);
  app.use(uploadRouter);

  // 404
  app.use((req, res) => {
    if (wantsJson(req)) return res.status(404).json({ error: 'Not found.' });
    res.status(404).render('error', { title: 'Not found', code: 404, message: 'That page does not exist.' });
  });

  // Global error handler
  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    let status = 500;
    let message = 'Something went wrong on our side. Please try again.';

    if (err instanceof DomainError) {
      status = httpStatusFor(err);
      message = err.message;
    } else if (err instanceof multer.MulterError) {
      status = 400;
      message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 10 MB).' : err.message;
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      message = 'Request is too large.';
    } else {
      console.error(`[${req.method} ${req.originalUrl}]`, err);
    }

    if (res.headersSent) return;
    if (wantsJson(req)) return res.status(status).json({ error: message });

    // For a failed form post, bounce back to the form with the message.
    const referer = req.get('referer');
    if (status < 500 && req.method === 'POST' && referer && req.session) {
      try {
        const ref = new URL(referer);
        if (ref.host === req.get('host')) {
          req.session.flash = [...(req.session.flash ?? []), { type: 'error', message }];
          return res.redirect(303, ref.pathname + ref.search);
        }
      } catch {
        /* fall through to error page */
      }
    }

    res.status(status).render('error', {
      title: 'Error',
      code: status,
      message,
      user: req.user ?? null,
      flash: [],
      currentPath: req.path,
    });
  };
  app.use(onError);

  return app;
}
