/**
 * Resolve the integration-test database URL: the TEST_DATABASE_URL environment
 * variable, else TEST_DATABASE_URL from .env.local / .env. Only the database
 * keys are read from those files; nothing else from them reaches the tests.
 *
 * Refuses to run if the test database is the app's own database, because the
 * tests create data and the seed test resets the demo organisation.
 */

import { existsSync, readFileSync } from 'fs';
import { parse } from 'dotenv';

function fromEnvFiles(key: string): string | undefined {
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    const value = parse(readFileSync(file))[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

const lookup = (key: string) => process.env[key] || fromEnvFiles(key);

/** Compare connection strings ignoring query parameters and trailing slashes. */
function sameDatabase(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const url = new URL(u);
      return `${url.username}@${url.hostname.replace(/-pooler(?=\.)/, '')}:${url.port || '5432'}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return u.trim();
    }
  };
  return norm(a) === norm(b);
}

export function resolveTestDatabaseUrl(): string | undefined {
  const url = lookup('TEST_DATABASE_URL');
  if (!url) return undefined;
  for (const key of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
    const appUrl = lookup(key);
    if (appUrl && sameDatabase(url, appUrl)) {
      throw new Error(
        `TEST_DATABASE_URL points at the same database as ${key}. Integration tests write data and reset the demo org; ` +
          'use a separate, throwaway database (e.g. a Neon branch or a local "spendwise_test").',
      );
    }
  }
  return url;
}
