/**
 * src/db/migrate.ts
 *
 * Applies the checked-in SQL migrations using drizzle-orm's runtime migrator,
 * so production doesn't need drizzle-kit (a dev dependency).
 *
 *   npm run migrate              (dev, via tsx)
 *   node dist/db/migrate.js      (prod; `npm start` runs this before the server)
 *
 * With SEED_DEMO=true it also seeds the Acme demo org if it doesn't exist yet,
 * which is how the free Render plan (no shell access) gets its demo data.
 */

import '../env.js';
import path from 'path';
import { pathToFileURL } from 'url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

export const MIGRATIONS_DIR = path.resolve('src/db/migrations');

/** Migrations prefer the direct (unpooled) connection when one is configured, e.g. on Neon. */
export async function runMigrations(url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL): Promise<void> {
  if (!url) throw new Error('DATABASE_URL is not set.');
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await client.end();
  }
}

async function main() {
  await runMigrations();
  console.log('Migrations applied.');
  if (process.env.SEED_DEMO === 'true') {
    const { seedDemo } = await import('./seed.js');
    await seedDemo({ ifMissing: true });
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
