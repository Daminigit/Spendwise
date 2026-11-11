/**
 * src/db/seed.ts
 *
 * Creates demo org "Acme Travel Pvt Ltd" with 4 users, 7 categories,
 * and ~3 months of past claims across all statuses.
 *
 * Run with: npm run seed
 * Password for all demo users: demo1234
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import * as argon2 from 'argon2';
import { db } from './index.js';
import {
  organisations,
  users,
  policy,
  categories,
  mcpTokens,
} from './schema.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
function id() {
  return randomUUID();
}

function paise(rupees: number) {
  return Math.round(rupees * 100);
}

// ── Seed ─────────────────────────────────────────────────────────────────────
async function seed() {
  console.log('🌱 Seeding Acme Travel Pvt Ltd...\n');

  // ── Organisation ──────────────────────────────────────────────────────────
  const orgId = id();
  await db.insert(organisations).values({
    id: orgId,
    name: 'Acme Travel Pvt Ltd',
    baseCurrency: 'INR',
  }).onConflictDoNothing();

  // ── Users ──────────────────────────────────────────────────────────────────
  const demoPassword = await argon2.hash('demo1234');

  const adminId = id();
  const managerId = id();
  const riyaId = id();
  const arjunId = id();

  await db.insert(users).values([
    {
      id: adminId,
      orgId,
      email: 'admin@acme.test',
      name: 'Admin User',
      passwordHash: demoPassword,
      role: 'admin',
      managerId: null,
    },
    {
      id: managerId,
      orgId,
      email: 'manager@acme.test',
      name: 'Priya Sharma',
      passwordHash: demoPassword,
      role: 'manager',
      managerId: adminId,
    },
    {
      id: riyaId,
      orgId,
      email: 'riya@acme.test',
      name: 'Riya Patel',
      passwordHash: demoPassword,
      role: 'employee',
      managerId,
    },
    {
      id: arjunId,
      orgId,
      email: 'arjun@acme.test',
      name: 'Arjun Mehta',
      passwordHash: demoPassword,
      role: 'employee',
      managerId,
    },
  ]).onConflictDoNothing();

  // ── Policy ────────────────────────────────────────────────────────────────
  await db.insert(policy).values({
    orgId,
    receiptRequiredAboveMinor: paise(500),
    gstinRequiredAboveMinor: paise(2000),
    allowWeekendSpend: false,
    notes: 'All expenses must have a valid business purpose. Client entertainment requires prior approval above ₹5,000.',
  }).onConflictDoNothing();

  // ── Categories ────────────────────────────────────────────────────────────
  await db.insert(categories).values([
    { id: id(), orgId, name: 'Travel',               code: 'TRAVEL', perItemLimitMinor: null,       perDayLimitMinor: null },
    { id: id(), orgId, name: 'Lodging',              code: 'LODGE',  perItemLimitMinor: paise(6000), perDayLimitMinor: null },
    { id: id(), orgId, name: 'Meals',                code: 'MEALS',  perItemLimitMinor: paise(1500), perDayLimitMinor: paise(2500) },
    { id: id(), orgId, name: 'Client Entertainment', code: 'ENT',    perItemLimitMinor: paise(10000),perDayLimitMinor: null },
    { id: id(), orgId, name: 'Software',             code: 'SW',     perItemLimitMinor: null,        perDayLimitMinor: null },
    { id: id(), orgId, name: 'Office Supplies',      code: 'OFFICE', perItemLimitMinor: null,        perDayLimitMinor: null },
    { id: id(), orgId, name: 'Other',                code: 'OTHER',  perItemLimitMinor: null,        perDayLimitMinor: null },
  ]).onConflictDoNothing();

  // ── Demo MCP token for Riya ────────────────────────────────────────────────
  const rawToken = `sw_demo_${randomUUID().replace(/-/g, '')}`;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  await db.insert(mcpTokens).values({
    id: id(),
    userId: riyaId,
    tokenHash,
    label: 'Demo token (Riya)',
  }).onConflictDoNothing();

  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';

  console.log('✅ Seed complete!\n');
  console.log('Demo accounts (password: demo1234)');
  console.log('  admin@acme.test  → Admin');
  console.log('  manager@acme.test → Manager (Priya)');
  console.log('  riya@acme.test   → Employee');
  console.log('  arjun@acme.test  → Employee\n');
  console.log('Riya\'s MCP connector URL (add to Claude):');
  console.log(`  ${appUrl}/mcp/${rawToken}\n`);
  console.log('NOTE: Full historical claims will be generated in Phase 6.');

  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

