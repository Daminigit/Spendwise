/**
 * src/domain/tokens.ts
 *
 * Per-user MCP connector tokens. The raw token is returned exactly once on
 * creation; only its sha256 hash is stored.
 */

import { createHash, randomBytes, randomUUID } from 'crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog, mcpTokens, users } from '../db/schema.js';
import type { McpToken, User } from '../db/schema.js';
import { DomainError } from './errors.js';
import { appUrl } from '../config.js';

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function connectorUrl(rawToken: string): string {
  return `${appUrl()}/mcp/${rawToken}`;
}

export type TokenSummary = Pick<McpToken, 'id' | 'label' | 'createdAt' | 'lastUsedAt' | 'revokedAt'>;

export async function listTokens(userId: string): Promise<TokenSummary[]> {
  return db
    .select({ id: mcpTokens.id, label: mcpTokens.label, createdAt: mcpTokens.createdAt, lastUsedAt: mcpTokens.lastUsedAt, revokedAt: mcpTokens.revokedAt })
    .from(mcpTokens)
    .where(eq(mcpTokens.userId, userId))
    .orderBy(desc(mcpTokens.createdAt));
}

export async function createToken(userId: string, label: string): Promise<{ id: string; rawToken: string; url: string }> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new DomainError('User not found.', 'not_found');

  const rawToken = `sw_${randomBytes(24).toString('base64url')}`;
  const id = randomUUID();
  await db.insert(mcpTokens).values({ id, userId, tokenHash: hashToken(rawToken), label: label.trim() || 'Default' });
  await db.insert(auditLog).values({ id: randomUUID(), orgId: user.orgId, actorUserId: userId, actorVia: 'web', entity: 'mcp_token', entityId: id, action: 'create', after: { label } });
  return { id, rawToken, url: connectorUrl(rawToken) };
}

export async function revokeToken(userId: string, tokenId: string): Promise<void> {
  const [tok] = await db.select().from(mcpTokens).where(and(eq(mcpTokens.id, tokenId), eq(mcpTokens.userId, userId)));
  if (!tok) throw new DomainError('Token not found.', 'not_found');
  if (tok.revokedAt) return;
  await db.update(mcpTokens).set({ revokedAt: new Date() }).where(eq(mcpTokens.id, tokenId));
  const [user] = await db.select({ orgId: users.orgId }).from(users).where(eq(users.id, userId));
  if (user) {
    await db.insert(auditLog).values({ id: randomUUID(), orgId: user.orgId, actorUserId: userId, actorVia: 'web', entity: 'mcp_token', entityId: tokenId, action: 'revoke' });
  }
}

/** Resolve a raw token to its (non-revoked) user. Updates last_used_at. Used by the MCP server. */
export async function authenticateToken(rawToken: string): Promise<User | null> {
  const [row] = await db
    .select({ token: mcpTokens, user: users })
    .from(mcpTokens)
    .innerJoin(users, eq(mcpTokens.userId, users.id))
    .where(and(eq(mcpTokens.tokenHash, hashToken(rawToken)), isNull(mcpTokens.revokedAt)));
  if (!row) return null;
  await db.update(mcpTokens).set({ lastUsedAt: new Date() }).where(eq(mcpTokens.id, row.token.id));
  return row.user;
}
