import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const launchDirectory = process.cwd();
const configuredDatabase = process.env.DATABASE_URL?.trim() || "./data/ledgerlab.db";
const databaseFile = configuredDatabase.startsWith("file:")
  ? configuredDatabase.slice("file:".length)
  : configuredDatabase;

// Next's standalone launcher changes the application directory. Resolve the
// database first so a relative path still means "relative to where I started
// LedgerLab" and never creates a second, apparently empty ledger under .next.
process.env.DATABASE_URL = databaseFile === ":memory:" || path.isAbsolute(databaseFile)
  ? databaseFile
  : path.resolve(launchDirectory, databaseFile);

const configuredAttachments = process.env.ATTACHMENTS_DIR?.trim();
if (configuredAttachments) {
  process.env.ATTACHMENTS_DIR = path.isAbsolute(configuredAttachments)
    ? configuredAttachments
    : path.resolve(launchDirectory, configuredAttachments);
}

const serverPath = path.join(launchDirectory, ".next", "standalone", "server.js");
if (!existsSync(serverPath)) {
  throw new Error("The production server is missing. Run `npm run build` before `npm run start`.");
}

await import(pathToFileURL(serverPath).href);
