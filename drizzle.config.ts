import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

config({ path: ['.env.local', '.env'], quiet: true });

// drizzle-kit needs a direct connection; prefer Neon's unpooled URL when present
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '';
const driver = process.env.DB_DRIVER ?? 'postgres';

export default defineConfig(
  driver === 'sqlite'
    ? {
        dialect: 'sqlite',
        schema: './src/db/schema.ts',
        out: './src/db/migrations',
        dbCredentials: { url: process.env.SQLITE_FILE ?? 'spendwise.db' },
      }
    : {
        dialect: 'postgresql',
        schema: './src/db/schema.ts',
        out: './src/db/migrations',
        dbCredentials: { url },
      },
);

