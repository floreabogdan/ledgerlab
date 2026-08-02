import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sourceDirectory = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyTestStub = fileURLToPath(
  new URL("./tests/stubs/server-only.ts", import.meta.url),
);

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    // Importing the database module opens its configured connection eagerly.
    // Keep every unit-test worker isolated from the user's real ledger.
    env: { DATABASE_URL: ":memory:", REGISTRATION_MODE: "open" },
    coverage: { reporter: ["text", "html"] },
  },
  resolve: {
    alias: {
      "@": sourceDirectory,
      "server-only": serverOnlyTestStub,
    },
  },
});
