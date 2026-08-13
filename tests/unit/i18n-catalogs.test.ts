import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTranslator,
  type RuntimeMessageCatalog,
} from "../../src/i18n/runtime";

import {
  defaultLocalesDirectory,
  loadCatalogs,
  renderGeneratedFiles,
} from "../../scripts/i18n";

const temporaryDirectories: string[] = [];

async function createLocalesFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ledgerlab-i18n-"));
  temporaryDirectories.push(root);
  const locales = path.join(root, "locales");
  await mkdir(locales);
  await cp(path.join(defaultLocalesDirectory, "en"), path.join(locales, "en"), {
    recursive: true,
  });
  return locales;
}

async function addSyntheticLanguage(locales: string) {
  const directory = path.join(locales, "zz");
  await cp(path.join(locales, "en"), directory, { recursive: true });
  await writeFile(
    path.join(directory, "manifest.yaml"),
    [
      "tag: zz",
      "nativeName: Test language",
      "englishName: Test language",
      "direction: ltr",
      "",
    ].join("\n"),
    "utf8",
  );
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("YAML language packs", () => {
  it("discovers a synthetic language and generates it without a source registry", async () => {
    const locales = await createLocalesFixture();
    const directory = await addSyntheticLanguage(locales);
    const commonFile = path.join(directory, "common.yaml");
    const common = await readFile(commonFile, "utf8");
    const syntheticWelcome = "Synthetic greeting for {name}.";
    expect(common).toContain("Welcome, {name}.");
    await writeFile(
      commonFile,
      common.replace("Welcome, {name}.", syntheticWelcome),
      "utf8",
    );

    const build = await loadCatalogs(locales);
    const generated = renderGeneratedFiles(build);
    const english = build.packs.find((pack) => pack.manifest.tag === "en");
    const synthetic = build.packs.find((pack) => pack.manifest.tag === "zz");

    expect(english).toBeDefined();
    expect(synthetic).toBeDefined();

    expect(build.packs.map((pack) => pack.manifest.tag)).toEqual(["en", "zz"]);
    expect(generated.get("manifests.ts")).toContain('"tag": "zz"');
    expect(generated.get("catalogs.ts")).toContain('"zz"');
    expect(generated.get("catalogs.ts")).toContain(syntheticWelcome);

    const translator = createTranslator({
      language: "zz",
      formattingLocale: "en-US",
      catalog: synthetic!.messages as RuntimeMessageCatalog,
      fallbackCatalog: english!.messages as RuntimeMessageCatalog,
      fallbackLanguage: "en",
    });
    expect(translator.translate("common.welcome.named", { name: "Ada" }))
      .toBe("Synthetic greeting for Ada.");
  });

  it("reports missing and unknown keys", async () => {
    const locales = await createLocalesFixture();
    const directory = await addSyntheticLanguage(locales);
    const commonFile = path.join(directory, "common.yaml");
    const common = await readFile(commonFile, "utf8");
    await writeFile(
      commonFile,
      common.replace("  noData: No data yet.\n", "  extraMessage: Extra\n"),
      "utf8",
    );

    await expect(loadCatalogs(locales)).rejects.toThrow(
      /missing keys: common\.status\.noData; unknown keys: common\.status\.extraMessage/,
    );
  });

  it("rejects mismatched named variables", async () => {
    const locales = await createLocalesFixture();
    const directory = await addSyntheticLanguage(locales);
    const commonFile = path.join(directory, "common.yaml");
    const common = await readFile(commonFile, "utf8");
    await writeFile(commonFile, common.replace("{name}", "{username}"), "utf8");

    await expect(loadCatalogs(locales)).rejects.toThrow(
      /common\.welcome\.named variables or select\/component slots do not match English/,
    );
  });

  it("rejects raw HTML in catalog messages", async () => {
    const locales = await createLocalesFixture();
    const directory = await addSyntheticLanguage(locales);
    const commonFile = path.join(directory, "common.yaml");
    const common = await readFile(commonFile, "utf8");
    await writeFile(
      commonFile,
      common.replace("Welcome, {name}.", "<strong>Welcome, {name}.</strong>"),
      "utf8",
    );

    await expect(loadCatalogs(locales)).rejects.toThrow(
      /contains an HTML tag/,
    );
  });
});
