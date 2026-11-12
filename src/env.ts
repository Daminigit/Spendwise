/**
 * src/env.ts
 *
 * Loads environment files: `.env.local` first (written by `neon deploy`, never
 * committed), then `.env`. Real environment variables always win, and a value
 * from `.env.local` wins over the same key in `.env`.
 *
 * Under NODE_ENV=test nothing is loaded: tests must never pick up a
 * developer's database, bucket or secrets (see tests/setup/).
 * Import this module first in every entry point.
 */

import { config } from 'dotenv';

export const ENV_FILES = ['.env.local', '.env'];

if (process.env.NODE_ENV !== 'test') {
  config({ path: ENV_FILES, quiet: true });
}
