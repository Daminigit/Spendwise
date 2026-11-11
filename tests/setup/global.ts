/**
 * Vitest globalSetup: apply migrations to the test database once per run.
 */

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.log('\nTEST_DATABASE_URL not set: integration tests will be skipped.\n');
    return;
  }
  const { runMigrations } = await import('../../src/db/migrate.js');
  await runMigrations(url);
}
