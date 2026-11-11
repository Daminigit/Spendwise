import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClaim, updateExpense } from '../../domain/claims.js';
import { DomainError } from '../../domain/errors.js';
import { claimUrl, expenseInput, presentLine, presentTotals, run, type McpContext } from '../util.js';

const editable = expenseInput.omit({ currency: true }).partial();

export function registerUpdateExpense(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'update_expense',
    {
      title: 'Update an expense line',
      description:
        'Change fields on one expense line; send only the fields to change. The claim owner can edit lines on a ' +
        "DRAFT claim; the owner's manager (or an admin) can edit lines on a SUBMITTED claim, e.g. to fix the " +
        'category before approving. Policy flags are re-checked. Send gstin as "" to clear it. Amounts in rupees.',
      inputSchema: {
        expense_id: z.string().trim().min(1).describe('expense_id from get_claim / create_claim'),
        ...editable.shape,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ expense_id, ...fields }) =>
      run('update_expense', async () => {
        const changes = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        if (Object.keys(changes).length === 0) {
          throw new DomainError(
            `Nothing to update. Send at least one of: ${Object.keys(editable.shape).join(', ')}.`,
            'invalid',
          );
        }
        const result = await updateExpense(expense_id, ctx.user.id, changes, 'mcp');
        const claim = await getClaim(result.claimId, ctx.user.id);
        const line = claim.expenses.find((e) => e.id === expense_id)!;
        return {
          claim_id: claim.id,
          line: presentLine(line),
          claim_totals: presentTotals(claim.totals),
          app_url: claimUrl(claim.id),
        };
      }),
  );
}
