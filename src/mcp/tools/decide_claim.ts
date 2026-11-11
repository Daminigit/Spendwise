import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { decideClaim } from '../../domain/claims.js';
import { DomainError } from '../../domain/errors.js';
import { claimUrl, run, type McpContext } from '../util.js';

export function registerDecideClaim(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'decide_claim',
    {
      title: 'Approve or reject a claim',
      description:
        'Approve or reject a SUBMITTED claim, line by line. Managers can decide claims from their direct reports; ' +
        'admins can decide any claim in the organisation. Either set approve_all=true, OR send decisions[] with ' +
        'exactly one entry for EVERY line of the claim (get expense_ids from get_claim). Rejected lines need a ' +
        'note. Only act on what the user has told you to approve or reject.',
      inputSchema: {
        claim_id: z.string().trim().min(1),
        approve_all: z.boolean().optional().describe('Approve every line. Do not combine with decisions.'),
        decisions: z
          .array(
            z.object({
              expense_id: z.string().trim().min(1),
              approve: z.boolean().describe('true = approve, false = reject'),
              note: z.string().max(1000).optional().describe('Required when rejecting'),
            }),
          )
          .optional()
          .describe('One decision per line of the claim'),
        note: z.string().max(1000).optional().describe('Overall note to the employee'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run('decide_claim', async () => {
        const hasDecisions = Boolean(args.decisions && args.decisions.length > 0);
        if (args.approve_all && hasDecisions) {
          throw new DomainError('Send either approve_all=true or decisions[], not both.', 'invalid');
        }
        if (!args.approve_all && !hasDecisions) {
          throw new DomainError('Nothing to decide. Send approve_all=true, or decisions[] with one entry per line.', 'invalid');
        }
        const ids = (args.decisions ?? []).map((d) => d.expense_id);
        const dup = ids.find((id, i) => ids.indexOf(id) !== i);
        if (dup) throw new DomainError(`expense_id ${dup} appears more than once in decisions.`, 'invalid');

        const result = await decideClaim(
          args.claim_id,
          ctx.user.id,
          (args.decisions ?? []).map((d) => ({ expenseId: d.expense_id, approve: d.approve, note: d.note })),
          Boolean(args.approve_all),
          args.note,
          'mcp',
        );
        return { claim_id: result.claimId, status: result.newStatus, app_url: claimUrl(result.claimId) };
      }),
  );
}
