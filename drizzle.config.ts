import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

config();

const url = process.env.DATABASE_URL ?? '';
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

