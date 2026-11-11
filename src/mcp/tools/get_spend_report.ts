import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getSpendReport } from '../../domain/reports.js';
import { DomainError } from '../../domain/errors.js';
import { formatINR } from '../../domain/money.js';
import { dateField, rupees, run, type McpContext } from '../util.js';

export function registerGetSpendReport(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'get_spend_report',
    {
      title: 'Spend report',
      description:
        'Spend totals between two expense dates, grouped by person, category or month, split into approved, ' +
        'pending and rejected (rupees); drafts are excluded. Admins see the whole organisation; managers see themselves and their ' +
        'direct reports. Employees cannot use this tool.',
      inputSchema: {
        from: dateField.describe('First expense date to include, YYYY-MM-DD'),
        to: dateField.describe('Last expense date to include, YYYY-MM-DD'),
        group_by: z.enum(['user', 'category', 'month']).describe('How to group the rows'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run('get_spend_report', async () => {
        if (args.to < args.from) throw new DomainError(`"to" (${args.to}) is before "from" (${args.from}).`, 'invalid');
        const rows = await getSpendReport(ctx.user.orgId, ctx.user.id, { from: args.from, to: args.to, groupBy: args.group_by });
        const totalMinor = rows.reduce((s, r) => s + r.totalMinor, 0);
        return {
          from: args.from,
          to: args.to,
          group_by: args.group_by,
          scope: ctx.user.role === 'admin' ? 'organisation' : 'you and your direct reports',
          rows: rows.map((r) => ({
            label: r.label,
            total: rupees(r.totalMinor),
            approved: rupees(r.approvedMinor),
            pending: rupees(r.pendingMinor),
            rejected: rupees(r.rejectedMinor),
            count: r.count,
          })),
          grand_total: rupees(totalMinor),
          grand_total_formatted: formatINR(totalMinor),
        };
      }),
  );
}
