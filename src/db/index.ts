import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { schema } from "./schema";

export type LedgerDatabase = ReturnType<typeof drizzle<typeof schema>>;

type Connection = {
  sqlite: BetterSqlite3.Database;
  db: LedgerDatabase;
  migrated: boolean;
};

declare global {
  var __ledgerLabConnection: Connection | undefined;
}

function databaseFile(): string {
  const configured = process.env.DATABASE_URL?.trim() || "./data/ledgerlab.db";
  return configured.startsWith("file:") ? configured.slice("file:".length) : configured;
}

export function openDatabase(file = databaseFile()): Connection {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }

  const raw = new BetterSqlite3(file);
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  if (file !== ":memory:") raw.pragma("journal_mode = WAL");

  return { sqlite: raw, db: drizzle(raw, { schema }), migrated: false };
}

const connection = globalThis.__ledgerLabConnection ?? openDatabase();
if (process.env.NODE_ENV !== "production") globalThis.__ledgerLabConnection = connection;

/** Raw better-sqlite3 handle for backup/restore and carefully scoped bulk operations. */
export const sqlite = connection.sqlite;
/** Typed Drizzle database used by application code. */
export const db = connection.db;

/**
 * Applies every checked-in migration exactly once (Drizzle records applied files).
 * Safe to call from every server entry point; subsequent calls in this process are a no-op.
 */
export function ensureDatabase(): LedgerDatabase {
  if (!connection.migrated) {
    migrate(connection.db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    connection.migrated = true;
  }
  return connection.db;
}

/** Isolated migrated database intended for domain/integration tests. */
export function createMemoryDatabase(): Connection {
  const memory = openDatabase(":memory:");
  migrate(memory.db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  memory.migrated = true;
  return memory;
}
