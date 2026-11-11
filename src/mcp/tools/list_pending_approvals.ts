import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listPendingApprovals } from '../../domain/claims.js';
import { presentSummary, run, type McpContext } from '../util.js';

export function registerListPendingApprovals(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'list_pending_approvals',
    {
      title: 'List claims waiting for my approval',
      description:
        'Managers: submitted claims from your direct reports. Admins: every submitted claim in the organisation. ' +
        'Oldest first, with totals and flag counts. Use get_claim to see the lines, then decide_claim.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run('list_pending_approvals', async () => {
        const claims = await listPendingApprovals(ctx.user.id);
        return { count: claims.length, claims: claims.map(presentSummary) };
      }),
  );
}
