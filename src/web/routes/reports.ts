/**
 * GET /reports             spend by person / category / month (manager: own team; admin: org)
 * GET /reports/export.csv  admin
 */

import { Router } from 'express';
import { requireRole } from '../../auth/middleware.js';
import { generateCSV, getSpendReport, type GroupBy } from '../../domain/reports.js';
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
    const csv = await generateCSV(req.user!.orgId, req.user!.id, { from, to });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="spendwise-${from}-to-${to}.csv"`);
    res.send(`\uFEFF${csv}`); // BOM so Excel opens UTF-8 (₹, names) correctly
  }),
);
