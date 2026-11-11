/**
 * src/mcp/server.ts
 *
 * MCP endpoint mounted at /mcp/:token. Phase 3 only authenticates the token;
 * the transport and tools arrive in Phase 4.
 */

import { Router } from 'express';
import { authenticateToken } from '../domain/tokens.js';

export function createMcpRouter(): Router {
  const router = Router();

  router.all('/:token', async (req, res, next) => {
    try {
      const user = await authenticateToken(String(req.params.token));
      if (!user) {
        return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or revoked token.' }, id: null });
      }
      res.status(501).json({ jsonrpc: '2.0', error: { code: -32601, message: 'MCP tools are not available yet.' }, id: null });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
