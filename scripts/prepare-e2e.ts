import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

async function main() {
  const dataDirectory = path.resolve(process.cwd(), "data");
  const databasePath = path.resolve(dataDirectory, "e2e.db");
  const attachmentsPath = path.resolve(dataDirectory, "e2e-attachments");

  if (
    path.dirname(databasePath) !== dataDirectory
    || path.basename(databasePath) !== "e2e.db"
    || path.dirname(attachmentsPath) !== dataDirectory
    || path.basename(attachmentsPath) !== "e2e-attachments"
  ) {
    throw new Error("Refusing to clean an unexpected end-to-end database path.");
  }

  mkdirSync(dataDirectory, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${databasePath}${suffix}`, { force: true, maxRetries: 3, retryDelay: 50 });
  }
  rmSync(attachmentsPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

  process.env.DATABASE_URL = databasePath;
  process.env.ATTACHMENTS_DIR = attachmentsPath;
  const { ensureDatabase, sqlite } = await import("../src/db");
  ensureDatabase();

  // Keep browser tests deterministic and offline. These are clearly marked test
  // observations and cover both sides of the date boundary used by the browser's
  // configured time zone. USD 1 = RON 4.50 and EUR 1 = RON 5.00.
  const now = new Date();
  const observations: Array<{ date: string; currency: "USD" | "EUR"; rate: number }> = [];
  for (let offset = 40; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - offset);
    const dateKey = date.toISOString().slice(0, 10);
    observations.push(
      { date: dateKey, currency: "USD", rate: 450_000_000 },
      { date: dateKey, currency: "EUR", rate: 500_000_000 },
    );
  }
  const insertObservation = sqlite.prepare(
    `INSERT INTO fx_rate_observations
      (id, rate_date, currency, published_rate_scaled, multiplier, source_url, fetched_at)
     VALUES (?, ?, ?, ?, 1, 'https://www.bnr.ro/ledgerlab-e2e-fixture', ?)`,
  );
  const fetchedAt = now.toISOString();
  sqlite.transaction(() => {
    for (const item of observations) {
      insertObservation.run(`e2e-${item.date}-${item.currency}`, item.date, item.currency, item.rate, fetchedAt);
    }
    const datesByYear = new Map<number, string[]>();
    for (const { date } of observations) {
      const year = Number(date.slice(0, 4));
      const dates = datesByYear.get(year) ?? [];
      if (!dates.includes(date)) dates.push(date);
      datesByYear.set(year, dates);
    }
    const insertMetadata = sqlite.prepare(
      `INSERT INTO fx_sync_metadata
        (year, source_url, publishing_date, first_observation_date, last_observation_date, observation_count, fetched_at)
       VALUES (?, 'https://www.bnr.ro/ledgerlab-e2e-fixture', ?, ?, ?, ?, ?)`,
    );
    for (const [year, dates] of datesByYear) {
      dates.sort();
      insertMetadata.run(year, dates.at(-1), dates[0], dates.at(-1), dates.length * 2, fetchedAt);
    }
  })();
  sqlite.close();

  console.log(`Prepared disposable Playwright database and receipt storage at ${databasePath}.`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
