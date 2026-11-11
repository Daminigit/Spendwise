/**
 * GET /reports             spend by person / category / month (manager: own team; admin: org)
 * GET /reports/export.csv  admin
 */

import { Router } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { requireRole } from '../../auth/middleware.js';
import { getSpendReport, streamExpenseCSV, type ExportScope, type GroupBy } from '../../domain/reports.js';
import { ah } from '../util.js';

export const reportsRouter = Router();

const GROUPS: GroupBy[] = ['user', 'category', 'month'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function defaultRange() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  return { from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

function readFilters(q: Record<string, unknown>) {
  const def = defaultRange();
  const from = typeof q.from === 'string' && DATE_RE.test(q.from) ? q.from : def.from;
  const to = typeof q.to === 'string' && DATE_RE.test(q.to) ? q.to : def.to;
  const groupBy = GROUPS.includes(q.groupBy as GroupBy) ? (q.groupBy as GroupBy) : 'user';
  return { from, to, groupBy };
}

reportsRouter.get(
  '/reports',
  requireRole('manager', 'admin'),
  ah(async (req, res) => {
    const filters = readFilters(req.query);
    const rows = await getSpendReport(req.user!.orgId, req.user!.id, filters);
    const totals = rows.reduce(
      (acc, r) => ({
        totalMinor: acc.totalMinor + r.totalMinor,
        approvedMinor: acc.approvedMinor + r.approvedMinor,
        pendingMinor: acc.pendingMinor + r.pendingMinor,
        rejectedMinor: acc.rejectedMinor + r.rejectedMinor,
        count: acc.count + r.count,
      }),
      { totalMinor: 0, approvedMinor: 0, pendingMinor: 0, rejectedMinor: 0, count: 0 },
    );
    res.render('reports/index', { title: 'Reports', rows, totals, filters, groups: GROUPS });
  }),
);

reportsRouter.get(
  '/reports/export.csv',
  requireRole('admin'),
  ah(async (req, res) => {
    const { from, to } = readFilters(req.query);
    const scope: ExportScope = req.query.scope === 'all' ? 'all' : 'approved';
    const chunks = streamExpenseCSV(req.user!.orgId, req.user!.id, { from, to, scope });

    // Pull the first chunk (header) before sending headers, so a permission
    // error still becomes a normal error response instead of a broken download.
    const first = await chunks.next();

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="spendwise-export-${scope}-${from}-to-${to}.csv"`);
    res.setHeader('Cache-Control', 'no-store');

    async function* body() {
      yield '﻿'; // BOM so Excel opens UTF-8 (₹, names) correctly
      if (!first.done) yield first.value;
      yield* chunks;
    }
    await pipeline(Readable.from(body()), res);
  }),
);
