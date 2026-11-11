/**
 * src/db/index.ts
 *
 * Database connection singleton.
 * Reads DB_DRIVER env var:
 *   - 'sqlite' → better-sqlite3 (local dev, no Postgres needed)
 *   - 'postgres' (default) → postgres driver pointing at DATABASE_URL
 */

import 'dotenv/config';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const driver = process.env.DB_DRIVER ?? 'postgres';

function createPostgresDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Add it to your .env file.');
  }
  const client = postgres(url, { max: 10 });
  return drizzlePg(client, { schema });
}

// We export a single db instance. For SQLite in dev we do a dynamic import
// to avoid bundling better-sqlite3 when it isn't installed (prod image).
let _db: ReturnType<typeof createPostgresDb> | undefined;

export function getDb() {
  if (!_db) {
    if (driver === 'sqlite') {
      throw new Error(
        'SQLite mode: call initSqliteDb() before getDb(), or set DB_DRIVER=postgres.',
      );
    }
    _db = createPostgresDb();
  }
  return _db;
}

// Convenience re-export so callers can just: import { db } from '@/db/index.js'
export const db = new Proxy({} as ReturnType<typeof createPostgresDb>, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    // Bind methods so `this` is the real drizzle instance, not the proxy
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

export { schema };
export type Db = ReturnType<typeof createPostgresDb>;

