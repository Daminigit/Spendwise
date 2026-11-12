/**
 * Runs before every test file (vitest setupFiles).
 *
 * Integration tests talk to Postgres at TEST_DATABASE_URL — never DATABASE_URL,
 * so a developer's own database is never touched. Without TEST_DATABASE_URL
 * the integration suites are skipped (see `hasTestDb`). TEST_DATABASE_URL may
 * also come from .env.local / .env; no other value from those files is used.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { resolveTestDatabaseUrl } from './test-db-url.js';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ??= 'test-session-secret-not-for-production';
process.env.APP_URL = 'http://spendwise.test';
delete process.env.S3_ENDPOINT; // receipts go to a temp dir in tests
process.env.UPLOADS_DIR = mkdtempSync(path.join(tmpdir(), 'spendwise-test-uploads-'));

// Decided once, here, before any app module (and src/env.ts) is imported
const testDbUrl = resolveTestDatabaseUrl();
if (testDbUrl) {
  process.env.TEST_DATABASE_URL = testDbUrl;
  process.env.DATABASE_URL = testDbUrl;
  delete process.env.DATABASE_URL_UNPOOLED;
} else {
  delete process.env.TEST_DATABASE_URL;
  // Make sure nothing accidentally connects to a real database
  process.env.DATABASE_URL = 'postgresql://invalid.invalid:1/no-test-db';
}
