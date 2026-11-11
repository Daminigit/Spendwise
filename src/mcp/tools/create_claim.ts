import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createClaim } from '../../domain/claims.js';
import { DomainError } from '../../domain/errors.js';
import { claimUrl, dateField, expenseInput, presentFlags, presentTotals, run, toDomainExpense, type McpContext } from '../util.js';

export function registerCreateClaim(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'create_claim',
    {
      title: 'Create expense claim',
      description:
        'Create a new expense claim for the caller from receipts you have read. Call get_policy first so ' +
        'categories match. Send one expense per receipt with amounts in rupees. The claim is saved as a DRAFT ' +
        'unless submit=true; only set submit=true if the user explicitly asked to submit. Returns the claim id, ' +
        'totals, per-line policy flags and a link. Report the flags to the user, and remind them to attach the ' +
        'receipt images on the claim page (images are not sent through this tool).',
      inputSchema: {
        title: z.string().trim().min(1).max(200).describe('Short title, e.g. "Bangalore client visit, 3–5 Nov"'),
        purpose: z.string().max(500).optional().describe('Business purpose of the trip / spend'),
        trip_start: dateField.optional().describe('First day of the trip, YYYY-MM-DD (enables OUTSIDE_TRIP checks)'),
        trip_end: dateField.optional().describe('Last day of the trip, YYYY-MM-DD'),
        expenses: z
          .array(expenseInput)
          .min(1, 'Include at least one expense (one per receipt).')
          .max(100, 'At most 100 expenses per call; split into create_claim + add_expenses.'),
        submit: z.boolean().optional().describe('Submit for approval immediately. Default false (draft).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run('create_claim', async () => {
        if (args.trip_start && args.trip_end && args.trip_end < args.trip_start) {
          throw new DomainError(`trip_end (${args.trip_end}) is before trip_start (${args.trip_start}).`, 'invalid');
        }
        const result = await createClaim(
          ctx.user.id,
          ctx.user.orgId,
          {
            title: args.title,
            purpose: args.purpose,
            trip_start: args.trip_start,
            trip_end: args.trip_end,
            expenses: args.expenses.map(toDomainExpense),
            submit: args.submit ?? false,
          },
          'mcp',
        );
        const flagged = result.perLineFlags.filter((l) => l.flags.length > 0).length;
        return {
          claim_id: result.claimId,
          status: result.status,
          totals: presentTotals(result.totals),
          lines: result.perLineFlags.map((l, i) => ({
            expense_id: l.expenseId,
            merchant: args.expenses[i].merchant,
            amount: args.expenses[i].amount,
            flags: presentFlags(l.flags),
          })),
          flagged_lines: flagged,
          app_url: claimUrl(result.claimId),
          next_steps:
            result.status === 'draft'
              ? 'Saved as a draft. The user should open app_url to attach receipt images, then submit (or ask you to call submit_claim).'
              : 'Submitted for approval. The user can still attach receipt images at app_url.',
        };
      }),
  );
}
