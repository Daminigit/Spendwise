import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClaim } from '../../domain/claims.js';
import { getPolicy } from '../../domain/org.js';
import { presentClaim, run, type McpContext } from '../util.js';

export function registerGetClaim(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'get_claim',
    {
      title: 'Get claim details',
      description:
        'Full detail of one claim: every line (with expense_id, amounts in rupees, GST split, flags, status, ' +
        'reviewer notes), comments and history. Callers can see their own claims; managers can see claims ' +
        "from their direct reports; admins can see every claim in the organisation.",
      inputSchema: {
        claim_id: z.string().trim().min(1).describe('Claim id from list_my_claims, list_pending_approvals or create_claim'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run('get_claim', async () => {
        const claim = await getClaim(args.claim_id, ctx.user.id);
        const { categories } = await getPolicy(claim.orgId);
        return presentClaim(claim, Object.fromEntries(categories.map((c) => [c.code, c.name])));
      }),
  );
}
