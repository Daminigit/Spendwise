/**
 * src/mcp/server.ts
 *
 * MCP endpoint at POST /mcp/:token (Streamable HTTP, stateless, JSON responses).
 *
 * Auth v1: the per-user secret in the URL is looked up by sha256 hash; revoked
 * tokens are rejected. Every tool runs as the token's user and goes through the
 * same domain functions (and permission checks) as the web app, with every write
 * audited as actor_via='mcp'.
 */

import { Router, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticateToken } from '../domain/tokens.js';
import type { McpContext } from './util.js';
import { registerGetPolicy } from './tools/get_policy.js';
import { registerCreateClaim } from './tools/create_claim.js';
import { registerAddExpenses } from './tools/add_expenses.js';
import { registerUpdateExpense } from './tools/update_expense.js';
import { registerSubmitClaim } from './tools/submit_claim.js';
import { registerListMyClaims } from './tools/list_my_claims.js';
import { registerGetClaim } from './tools/get_claim.js';
import { registerListPendingApprovals } from './tools/list_pending_approvals.js';
import { registerDecideClaim } from './tools/decide_claim.js';
import { registerGetSpendReport } from './tools/get_spend_report.js';

const INSTRUCTIONS =
  'Spendwise records expense claims for the connected user. Typical flow: call get_policy first, read the ' +
  "user's receipt images yourself, then call create_claim with one expense per receipt (amounts in rupees, " +
  'category from get_policy). Claims are saved as drafts; only submit when the user asks. Always tell the user ' +
  'which lines were flagged and share the app_url so they can attach receipt images. Managers can use ' +
  'list_pending_approvals, get_claim and decide_claim.';

/** Build a fresh MCP server bound to one authenticated user (stateless: one per request). */
export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'spendwise', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  registerGetPolicy(server, ctx);
  registerCreateClaim(server, ctx);
  registerAddExpenses(server, ctx);
  registerUpdateExpense(server, ctx);
  registerSubmitClaim(server, ctx);
  registerListMyClaims(server, ctx);
  registerGetClaim(server, ctx);
  registerListPendingApprovals(server, ctx);
  registerDecideClaim(server, ctx);
  registerGetSpendReport(server, ctx);
  return server;
}

function rpcError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

async function handlePost(req: Request, res: Response) {
  const user = await authenticateToken(String(req.params.token));
  if (!user) {
    return rpcError(
      res,
      401,
      -32001,
      'Invalid or revoked Spendwise token. Generate a new connector URL in Spendwise → Settings → Connect Claude.',
    );
  }

  const server = buildMcpServer({ user });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

export function createMcpRouter(): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/:token', (req, res) => {
    handlePost(req, res).catch((err) => {
      console.error('[mcp] request failed', err);
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error.');
    });
  });

  // Stateless server: no SSE stream to resume and no session to delete.
  router.all('/:token', (_req, res) => {
    res.setHeader('Allow', 'POST');
    rpcError(res, 405, -32000, 'Method not allowed. Use POST.');
  });

  return router;
}
