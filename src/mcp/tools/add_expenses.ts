import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { addExpenses } from '../../domain/claims.js';
import { claimUrl, expenseInput, presentFlags, presentTotals, run, toDomainExpense, type McpContext } from '../util.js';

export function registerAddExpenses(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'add_expenses',
    {
      title: 'Add expenses to a draft claim',
      description:
        "Add more expense lines (one per receipt) to one of the caller's DRAFT claims. Use list_my_claims to " +
        'find the claim_id. Same expense shape as create_claim; amounts in rupees. Returns updated totals and flags.',
      inputSchema: {
        claim_id: z.string().trim().min(1).describe('Id of a draft claim owned by the caller'),
        expenses: z.array(expenseInput).min(1, 'Include at least one expense.').max(100),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run('add_expenses', async () => {
        const result = await addExpenses(args.claim_id, ctx.user.id, args.expenses.map(toDomainExpense), 'mcp');
        return {
          claim_id: args.claim_id,
          added: result.expenseResults.map((l, i) => ({
            expense_id: l.expenseId,
            merchant: args.expenses[i].merchant,
            amount: args.expenses[i].amount,
            flags: presentFlags(l.flags),
          })),
          totals: presentTotals(result.totals),
          app_url: claimUrl(args.claim_id),
        };
      }),
  );
}
