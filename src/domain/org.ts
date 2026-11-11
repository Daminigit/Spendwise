/**
 * src/domain/org.ts
 *
 * Organisation lifecycle: signup, policy & category editing, team management
 * and invite links. Called by web routes (and later MCP tools); no HTTP here.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog, categories, organisations, policy, users } from '../db/schema.js';
import type { AuditVia, Category, Policy, User, UserRole } from '../db/schema.js';
import { DomainError } from './errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ROLES: UserRole[] = ['employee', 'manager', 'admin'];

export const DEFAULT_CATEGORIES: Array<{
  name: string;
  code: string;
  perItemLimitMinor: number | null;
  perDayLimitMinor: number | null;
}> = [
  { name: 'Travel', code: 'TRAVEL', perItemLimitMinor: null, perDayLimitMinor: null },
  { name: 'Lodging', code: 'LODGE', perItemLimitMinor: 600000, perDayLimitMinor: null },
  { name: 'Meals', code: 'MEALS', perItemLimitMinor: 150000, perDayLimitMinor: 250000 },
  { name: 'Client Entertainment', code: 'ENT', perItemLimitMinor: 1000000, perDayLimitMinor: null },
  { name: 'Software', code: 'SW', perItemLimitMinor: null, perDayLimitMinor: null },
  { name: 'Office Supplies', code: 'OFFICE', perItemLimitMinor: null, perDayLimitMinor: null },
  { name: 'Other', code: 'OTHER', perItemLimitMinor: null, perDayLimitMinor: null },
];

async function writeAudit(params: {
  orgId: string;
  actorUserId: string | null;
  actorVia: AuditVia;
  entity: string;
  entityId: string;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}) {
  await db.insert(auditLog).values({
    id: randomUUID(),
    orgId: params.orgId,
    actorUserId: params.actorUserId,
    actorVia: params.actorVia,
    entity: params.entity,
    entityId: params.entityId,
    action: params.action,
    before: params.before ?? null,
    after: params.after ?? null,
  });
}

async function requireAdmin(actorId: string): Promise<User> {
  const [actor] = await db.select().from(users).where(eq(users.id, actorId));
  if (!actor) throw new DomainError('User not found.', 'not_found');
  if (actor.role !== 'admin') throw new DomainError('Only admins can do this.', 'forbidden');
  return actor;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const [u] = await db.select().from(users).where(eq(users.email, normaliseEmail(email)));
  return u;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signup
// ─────────────────────────────────────────────────────────────────────────────

export interface SignupInput {
  orgName: string;
  name: string;
  email: string;
  passwordHash: string;
}

/** Create a new organisation with default policy + categories; the user becomes admin. */
export async function signupWithNewOrg(input: SignupInput): Promise<User> {
  const email = normaliseEmail(input.email);
  if (await findUserByEmail(email)) {
    throw new DomainError('An account with this email already exists.', 'conflict');
  }

  const orgId = randomUUID();
  const userId = randomUUID();

  const user = await db.transaction(async (tx) => {
    await tx.insert(organisations).values({ id: orgId, name: input.orgName.trim(), baseCurrency: 'INR' });
    const [u] = await tx
      .insert(users)
      .values({ id: userId, orgId, email, name: input.name.trim(), passwordHash: input.passwordHash, role: 'admin' })
      .returning();
    await tx.insert(policy).values({ orgId });
    await tx.insert(categories).values(DEFAULT_CATEGORIES.map((c) => ({ id: randomUUID(), orgId, ...c })));
    return u;
  });

  await writeAudit({ orgId, actorUserId: userId, actorVia: 'web', entity: 'organisation', entityId: orgId, action: 'create', after: { name: input.orgName } });
  return user;
}

/** Join an existing organisation through a verified invite. */
export async function signupWithInvite(
  invite: InvitePayload,
  input: Omit<SignupInput, 'orgName'>,
): Promise<User> {
  const email = normaliseEmail(input.email);
  if (await findUserByEmail(email)) {
    throw new DomainError('An account with this email already exists.', 'conflict');
  }
  const [org] = await db.select().from(organisations).where(eq(organisations.id, invite.orgId));
  if (!org) throw new DomainError('This invite is no longer valid.', 'invalid');

  // Manager must still exist in the same org; otherwise drop it.
  let managerId: string | null = invite.managerId ?? null;
  if (managerId) {
    const mgr = await findUserById(managerId);
    if (!mgr || mgr.orgId !== org.id) managerId = null;
  }

  const [user] = await db
    .insert(users)
    .values({ id: randomUUID(), orgId: org.id, email, name: input.name.trim(), passwordHash: input.passwordHash, role: invite.role, managerId })
    .returning();

  await writeAudit({ orgId: org.id, actorUserId: user.id, actorVia: 'web', entity: 'user', entityId: user.id, action: 'join', after: { role: invite.role, managerId } });
  return user;
}

// ─────────────────────────────────────────────────────────────────────────────
// Invites (stateless, HMAC-signed — no table needed)
// ─────────────────────────────────────────────────────────────────────────────

export interface InvitePayload {
  orgId: string;
  role: UserRole;
  managerId?: string | null;
  exp: number; // epoch ms
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function inviteSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET env var is not set.');
  return s;
}

function sign(data: string): string {
  return createHmac('sha256', inviteSecret()).update(`invite:${data}`).digest('base64url');
}

export async function createInvite(
  actorId: string,
  role: UserRole,
  managerId: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const actor = await requireAdmin(actorId);
  if (!ROLES.includes(role)) throw new DomainError('Invalid role.');
  if (managerId) {
    const mgr = await findUserById(managerId);
    if (!mgr || mgr.orgId !== actor.orgId) throw new DomainError('Manager not found in your organisation.', 'not_found');
  }
  const payload: InvitePayload = { orgId: actor.orgId, role, managerId, exp: Date.now() + INVITE_TTL_MS };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${data}.${sign(data)}`, expiresAt: new Date(payload.exp) };
}

/** Returns the payload if the token is authentic and unexpired, else null. */
export function verifyInvite(token: string): InvitePayload | null {
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = Buffer.from(sign(data));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as InvitePayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (!ROLES.includes(payload.role)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function getOrganisation(orgId: string) {
  const [org] = await db.select().from(organisations).where(eq(organisations.id, orgId));
  return org;
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy & categories
// ─────────────────────────────────────────────────────────────────────────────

export async function getPolicy(orgId: string): Promise<{ policy: Policy; categories: Category[] }> {
  const [pol] = await db.select().from(policy).where(eq(policy.orgId, orgId));
  if (!pol) throw new DomainError('Organisation policy not found.', 'not_found');
  const cats = await db.select().from(categories).where(eq(categories.orgId, orgId)).orderBy(categories.name);
  return { policy: pol, categories: cats };
}

export interface PolicyUpdate {
  receiptRequiredAboveMinor: number;
  gstinRequiredAboveMinor: number;
  allowWeekendSpend: boolean;
  notes: string;
}

export async function updatePolicy(actorId: string, update: PolicyUpdate, via: AuditVia): Promise<Policy> {
  const actor = await requireAdmin(actorId);
  const [before] = await db.select().from(policy).where(eq(policy.orgId, actor.orgId));
  const [after] = await db.update(policy).set(update).where(eq(policy.orgId, actor.orgId)).returning();
  await writeAudit({ orgId: actor.orgId, actorUserId: actorId, actorVia: via, entity: 'policy', entityId: actor.orgId, action: 'update', before: before ?? null, after: { ...update } });
  return after;
}

export interface CategoryUpsert {
  id?: string; // absent → create
  name: string;
  code: string;
  perItemLimitMinor: number | null;
  perDayLimitMinor: number | null;
  active: boolean;
}

export async function upsertCategories(actorId: string, rows: CategoryUpsert[], via: AuditVia): Promise<void> {
  const actor = await requireAdmin(actorId);
  const existing = await db.select().from(categories).where(eq(categories.orgId, actor.orgId));

  // Reject duplicate codes within the submitted set
  const codes = rows.map((r) => r.code.trim().toUpperCase());
  const dup = codes.find((c, i) => codes.indexOf(c) !== i);
  if (dup) throw new DomainError(`Category code '${dup}' is used more than once.`, 'conflict');

  for (const row of rows) {
    const values = {
      name: row.name.trim(),
      code: row.code.trim().toUpperCase(),
      perItemLimitMinor: row.perItemLimitMinor,
      perDayLimitMinor: row.perDayLimitMinor,
      active: row.active,
    };
    if (row.id) {
      const before = existing.find((c) => c.id === row.id);
      if (!before) throw new DomainError('Category not found.', 'not_found');
      const changed = (Object.keys(values) as Array<keyof typeof values>).some((k) => before[k] !== values[k]);
      if (!changed) continue;
      await db.update(categories).set(values).where(and(eq(categories.id, row.id), eq(categories.orgId, actor.orgId)));
      await writeAudit({ orgId: actor.orgId, actorUserId: actorId, actorVia: via, entity: 'category', entityId: row.id, action: 'update', before: { ...before }, after: values });
    } else {
      const id = randomUUID();
      await db.insert(categories).values({ id, orgId: actor.orgId, ...values });
      await writeAudit({ orgId: actor.orgId, actorUserId: actorId, actorVia: via, entity: 'category', entityId: id, action: 'create', after: values });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Team
// ─────────────────────────────────────────────────────────────────────────────

export type TeamMember = Pick<User, 'id' | 'name' | 'email' | 'role' | 'managerId' | 'createdAt'>;

export async function listTeam(orgId: string): Promise<TeamMember[]> {
  return db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, managerId: users.managerId, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.orgId, orgId))
    .orderBy(users.name);
}

export async function updateMember(
  actorId: string,
  memberId: string,
  update: { role: UserRole; managerId: string | null },
  via: AuditVia,
): Promise<void> {
  const actor = await requireAdmin(actorId);
  const member = await findUserById(memberId);
  if (!member || member.orgId !== actor.orgId) throw new DomainError('Member not found.', 'not_found');
  if (!ROLES.includes(update.role)) throw new DomainError('Invalid role.');

  if (update.managerId) {
    if (update.managerId === memberId) throw new DomainError('A member cannot be their own manager.');
    const mgr = await findUserById(update.managerId);
    if (!mgr || mgr.orgId !== actor.orgId) throw new DomainError('Manager not found in your organisation.', 'not_found');
    // Prevent cycles: walk up from the proposed manager
    let cursor: string | null = mgr.managerId;
    for (let i = 0; cursor && i < 50; i++) {
      if (cursor === memberId) throw new DomainError('That would create a reporting loop.');
      cursor = (await findUserById(cursor))?.managerId ?? null;
    }
  }

  // Never leave the org without an admin
  if (member.role === 'admin' && update.role !== 'admin') {
    const otherAdmins = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, actor.orgId), eq(users.role, 'admin'), ne(users.id, memberId)));
    if (otherAdmins.length === 0) throw new DomainError('The organisation needs at least one admin.');
  }

  if (member.role === update.role && member.managerId === update.managerId) return;

  await db.update(users).set({ role: update.role, managerId: update.managerId }).where(eq(users.id, memberId));
  await writeAudit({
    orgId: actor.orgId,
    actorUserId: actorId,
    actorVia: via,
    entity: 'user',
    entityId: memberId,
    action: 'update',
    before: { role: member.role, managerId: member.managerId },
    after: { role: update.role, managerId: update.managerId },
  });
}
