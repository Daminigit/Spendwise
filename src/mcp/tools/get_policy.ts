import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findUserById, getOrganisation, getPolicy } from '../../domain/org.js';
import { formatINR } from '../../domain/money.js';
import { rupees, run, type McpContext } from '../util.js';

export function registerGetPolicy(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'get_policy',
    {
      title: 'Get expense policy',
      description:
        "Call this FIRST in any expense conversation. Returns the organisation's expense categories " +
        '(use their name or code in the "category" field of other tools), per-item and per-day limits, ' +
        'the receipt and GSTIN thresholds, the weekend rule, free-text policy notes, and the caller\'s role ' +
        'and manager. All amounts are in rupees (INR, major units).',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run('get_policy', async () => {
        const [{ policy, categories }, org, manager] = await Promise.all([
          getPolicy(ctx.user.orgId),
          getOrganisation(ctx.user.orgId),
          ctx.user.managerId ? findUserById(ctx.user.managerId) : Promise.resolve(undefined),
        ]);
        return {
          organisation: org?.name,
          currency: 'INR',
          you: {
            name: ctx.user.name,
            email: ctx.user.email,
            role: ctx.user.role,
            manager: manager ? manager.name : null,
            can_approve: ctx.user.role !== 'employee',
          },
          categories: categories
            .filter((c) => c.active)
            .map((c) => ({
              name: c.name,
              code: c.code,
              per_item_limit: c.perItemLimitMinor == null ? null : rupees(c.perItemLimitMinor),
              per_day_limit: c.perDayLimitMinor == null ? null : rupees(c.perDayLimitMinor),
            })),
          rules: {
            receipt_required_above: rupees(policy.receiptRequiredAboveMinor),
            gstin_required_above: rupees(policy.gstinRequiredAboveMinor),
            weekend_spend_allowed: policy.allowWeekendSpend,
            summary:
              `Receipt image needed above ${formatINR(policy.receiptRequiredAboveMinor)}; ` +
              `supplier GSTIN needed above ${formatINR(policy.gstinRequiredAboveMinor)}; ` +
              (policy.allowWeekendSpend ? 'weekend spend is allowed.' : 'weekend spend is flagged for the approver.'),
          },
          notes: policy.notes,
          flags_explained:
            'Rule checks never block a claim; they add flags (e.g. OVER_ITEM_LIMIT, MISSING_GSTIN, WEEKEND, ' +
            'POSSIBLE_DUPLICATE) that the approver sees. Tell the user about any flags.',
        };
      }),
  );
}
