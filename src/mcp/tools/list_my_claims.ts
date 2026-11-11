import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listClaims } from '../../domain/claims.js';
import { DomainError } from '../../domain/errors.js';
import { dateField, presentSummary, run, type McpContext } from '../util.js';

export function registerListMyClaims(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'list_my_claims',
    {
      title: 'List my claims',
      description:
        "List the caller's own claims, newest first, with status, total (rupees), line and flag counts. " +
        'Optionally filter by status and by creation date range.',
      inputSchema: {
        status: z
          .enum(['draft', 'submitted', 'approved', 'partially_approved', 'rejected', 'paid'])
          .optional()
          .describe('Only claims with this status'),
        from: dateField.optional().describe('Created on or after, YYYY-MM-DD'),
        to: dateField.optional().describe('Created on or before, YYYY-MM-DD'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run('list_my_claims', async () => {
        if (args.from && args.to && args.to < args.from) {
          throw new DomainError(`"to" (${args.to}) is before "from" (${args.from}).`, 'invalid');
        }
        // `to` is a date; include the whole day
        const claims = await listClaims(ctx.user.id, {
          status: args.status,
          from: args.from,
          to: args.to ? `${args.to}T23:59:59.999Z` : undefined,
        });
        return { count: claims.length, claims: claims.map(presentSummary) };
      }),
  );
}
