/**
 * Runs before every test file (vitest setupFiles).
 *
 * Integration tests talk to Postgres at TEST_DATABASE_URL — never DATABASE_URL,
 * so a developer's own database is never touched. Without TEST_DATABASE_URL
 * the integration suites are skipped (see `hasTestDb`).
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ??= 'test-session-secret-not-for-production';
process.env.APP_URL = 'http://spendwise.test';
delete process.env.S3_ENDPOINT; // receipts go to a temp dir in tests
process.env.UPLOADS_DIR = mkdtempSync(path.join(tmpdir(), 'spendwise-test-uploads-'));

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  // Make sure nothing accidentally connects to a real database
  process.env.DATABASE_URL = 'postgresql://invalid.invalid:1/no-test-db';
}
