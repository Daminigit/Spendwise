import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClaim, submitClaim } from '../../domain/claims.js';
import { claimUrl, presentFlags, run, type McpContext } from '../util.js';

export function registerSubmitClaim(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'submit_claim',
    {
      title: 'Submit claim for approval',
      description:
        "Submit one of the caller's DRAFT claims to their manager. Only call this when the user has asked to " +
        'submit. After submitting, the claim can no longer be edited by the employee. Submission adds a ' +
        'MISSING_RECEIPT flag to lines above the receipt threshold that have no image attached yet.',
      inputSchema: {
        claim_id: z.string().trim().min(1).describe('Id of a draft claim owned by the caller'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run('submit_claim', async () => {
        const result = await submitClaim(args.claim_id, ctx.user.id, 'mcp');
        const claim = await getClaim(args.claim_id, ctx.user.id);
        return {
          claim_id: result.claimId,
          status: result.status,
          approver: result.approverName ?? 'an admin (you have no manager set)',
          flagged_lines: claim.expenses
            .filter((e) => e.flags.length > 0)
            .map((e) => ({ expense_id: e.id, merchant: e.merchant, flags: presentFlags(e.flags) })),
          app_url: claimUrl(result.claimId),
        };
      }),
  );
}
