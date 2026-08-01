import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const standaloneRoot = path.join(root, ".next", "standalone");

if (!existsSync(path.join(standaloneRoot, "server.js"))) {
  throw new Error("The standalone Next.js server was not produced. Check next.config.ts before starting LedgerLab.");
}

const staticSource = path.join(root, ".next", "static");
const staticTarget = path.join(standaloneRoot, ".next", "static");
mkdirSync(path.dirname(staticTarget), { recursive: true });
cpSync(staticSource, staticTarget, { recursive: true, force: true });

const publicSource = path.join(root, "public");
if (existsSync(publicSource)) {
  cpSync(publicSource, path.join(standaloneRoot, "public"), { recursive: true, force: true });
}
