import { ensureDatabase, sqlite } from "../src/db";

try {
  ensureDatabase();
  const migrationCount = sqlite
    .prepare("SELECT count(*) AS count FROM __drizzle_migrations")
    .get() as { count: number };
  console.log(`LedgerLab database is ready (${migrationCount.count} migration(s) applied).`);
} finally {
  sqlite.close();
}

