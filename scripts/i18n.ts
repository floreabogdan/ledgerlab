import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  TYPE,
  parse as parseMessage,
  type MessageFormatElement,
  type PluralElement,
  type SelectElement,
} from "@formatjs/icu-messageformat-parser";
import { parseDocument } from "yaml";

export const catalogNames = [
  "common",
  "auth",
  "finance",
  "planning",
  "settings",
  "errors",
] as const;

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const defaultLocalesDirectory = path.join(repositoryRoot, "locales");
export const defaultGeneratedDirectory = path.join(
  repositoryRoot,
  "src",
  "i18n",
  "generated",
);

const requiredPackFiles = [
  "manifest.yaml",
  ...catalogNames.map((name) => `${name}.yaml`),
].sort();

const htmlTagPattern =
  /<\/?(?:a|abbr|address|article|aside|audio|b|blockquote|body|br|button|canvas|caption|cite|code|col|data|datalist|dd|del|details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hgroup|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|menu|meta|meter|nav|noscript|object|ol|optgroup|option|output|p|picture|pre|progress|q|rp|rt|ruby|s|samp|script|search|section|select|slot|small|source|span|strong|style|sub|summary|sup|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr)\b[^>]*>/i;

type TextDirection = "ltr" | "rtl";

export interface LanguageManifest {
  tag: string;
  nativeName: string;
  englishName: string | null;
  direction: TextDirection;
}

export interface LanguagePack {
  directory: string;
  manifest: LanguageManifest;
  messages: Record<string, string>;
  signatures: Record<string, readonly string[]>;
}

export interface CatalogBuild {
  defaultLanguage: "en";
  keys: readonly string[];
  packs: readonly LanguagePack[];
}

class CatalogError extends Error {
  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = "CatalogError";
  }
}

function displayPath(file: string, localesDirectory: string) {
  return path.relative(localesDirectory, file).replaceAll(path.sep, "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readUtf8(file: string, localesDirectory: string) {
  const bytes = await readFile(file);

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      "file must contain valid UTF-8",
    );
  }
}

async function readYaml(file: string, localesDirectory: string): Promise<unknown> {
  const source = await readUtf8(file, localesDirectory);
  const document = parseDocument(source, {
    prettyErrors: true,
    uniqueKeys: true,
  });
  const problems = [...document.errors, ...document.warnings];

  if (problems.length > 0) {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      problems.map((problem) => problem.message).join("; "),
    );
  }

  return document.toJS({ maxAliasCount: 100 });
}

function requireString(
  value: unknown,
  key: string,
  file: string,
  localesDirectory: string,
) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      `manifest.${key} must be a non-empty string`,
    );
  }

  return value;
}

async function readManifest(
  directory: string,
  directoryName: string,
  localesDirectory: string,
): Promise<LanguageManifest> {
  const file = path.join(directory, "manifest.yaml");
  const value = await readYaml(file, localesDirectory);

  if (!isRecord(value)) {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      "manifest must be a mapping",
    );
  }

  const allowedKeys = new Set(["tag", "nativeName", "englishName", "direction"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      `unknown manifest field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`,
    );
  }

  const tag = requireString(value.tag, "tag", file, localesDirectory);
  const nativeName = requireString(
    value.nativeName,
    "nativeName",
    file,
    localesDirectory,
  );
  const englishName =
    value.englishName === undefined
      ? null
      : requireString(value.englishName, "englishName", file, localesDirectory);

  if (value.direction !== "ltr" && value.direction !== "rtl") {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      'manifest.direction must be either "ltr" or "rtl"',
    );
  }

  let canonicalTag: string;
  try {
    canonicalTag = Intl.getCanonicalLocales(tag)[0];
  } catch {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      `manifest.tag is not a valid BCP 47 language tag: ${tag}`,
    );
  }

  if (canonicalTag !== tag) {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      `manifest.tag must use canonical BCP 47 casing (${canonicalTag})`,
    );
  }

  if (directoryName !== tag) {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      `directory name must match manifest.tag (${tag})`,
    );
  }

  return { tag, nativeName, englishName, direction: value.direction };
}

function flattenCatalog(
  value: unknown,
  prefix: string,
  file: string,
  localesDirectory: string,
  output: Record<string, string>,
) {
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new CatalogError(
        displayPath(file, localesDirectory),
        `${prefix} must not be empty`,
      );
    }
    output[prefix] = value;
    return;
  }

  if (!isRecord(value)) {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      `${prefix || "catalog"} must be a mapping or message string`,
    );
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      `${prefix || "catalog"} must not be empty`,
    );
  }

  for (const [key, child] of entries) {
    if (!/^[a-z][A-Za-z0-9_]*$/.test(key)) {
      throw new CatalogError(
        displayPath(file, localesDirectory),
        `${prefix ? `${prefix}.` : ""}${key} is not a valid semantic key segment`,
      );
    }
    flattenCatalog(
      child,
      prefix ? `${prefix}.${key}` : key,
      file,
      localesDirectory,
      output,
    );
  }
}

function validatePluralOptions(
  element: PluralElement,
  languageTag: string,
  file: string,
  key: string,
  localesDirectory: string,
) {
  const optionNames = Object.keys(element.options);
  if (!optionNames.includes("other")) {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      `${key} plural for {${element.value}} requires an "other" branch`,
    );
  }

  const pluralType = element.pluralType === "ordinal" ? "ordinal" : "cardinal";
  const validCategories = new Set<string>(
    new Intl.PluralRules(languageTag, { type: pluralType }).resolvedOptions()
      .pluralCategories,
  );

  for (const option of optionNames) {
    const isExactNumber = /^=-?\d+(?:\.\d+)?$/.test(option);
    if (option !== "other" && !isExactNumber && !validCategories.has(option)) {
      throw new CatalogError(
        displayPath(file, localesDirectory),
        `${key} has invalid ${pluralType} plural branch "${option}" for ${languageTag}`,
      );
    }
  }
}

function validateSelectOptions(
  element: SelectElement,
  file: string,
  key: string,
  localesDirectory: string,
) {
  if (!Object.hasOwn(element.options, "other")) {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      `${key} select for {${element.value}} requires an "other" branch`,
    );
  }
}

function inspectMessageElements(
  elements: MessageFormatElement[],
  languageTag: string,
  file: string,
  key: string,
  localesDirectory: string,
  signature: Set<string>,
) {
  for (const element of elements) {
    switch (element.type) {
      case TYPE.argument:
        signature.add(`argument:${element.value}`);
        break;
      case TYPE.number:
        signature.add(`number:${element.value}`);
        break;
      case TYPE.date:
        signature.add(`date:${element.value}`);
        break;
      case TYPE.time:
        signature.add(`time:${element.value}`);
        break;
      case TYPE.select: {
        validateSelectOptions(element, file, key, localesDirectory);
        const branches = Object.keys(element.options).sort().join("|");
        signature.add(`select:${element.value}:${branches}`);
        for (const option of Object.values(element.options)) {
          inspectMessageElements(
            option.value,
            languageTag,
            file,
            key,
            localesDirectory,
            signature,
          );
        }
        break;
      }
      case TYPE.plural:
        validatePluralOptions(element, languageTag, file, key, localesDirectory);
        signature.add(`plural:${element.pluralType}:${element.value}`);
        for (const option of Object.values(element.options)) {
          inspectMessageElements(
            option.value,
            languageTag,
            file,
            key,
            localesDirectory,
            signature,
          );
        }
        break;
      case TYPE.tag:
        signature.add(`tag:${element.value}`);
        inspectMessageElements(
          element.children,
          languageTag,
          file,
          key,
          localesDirectory,
          signature,
        );
        break;
      case TYPE.literal:
      case TYPE.pound:
        break;
    }
  }
}

function messageSignature(
  message: string,
  languageTag: string,
  file: string,
  key: string,
  localesDirectory: string,
) {
  if (htmlTagPattern.test(message)) {
    throw new CatalogError(
      displayPath(file, localesDirectory),
      `${key} contains an HTML tag; use an abstract ICU component slot instead`,
    );
  }

  let elements: MessageFormatElement[];
  try {
    elements = parseMessage(message, {
      captureLocation: false,
      requiresOtherClause: true,
      shouldParseSkeletons: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CatalogError(
      displayPath(file, localesDirectory),
      `${key} has invalid ICU message syntax: ${detail}`,
    );
  }

  const signature = new Set<string>();
  inspectMessageElements(
    elements,
    languageTag,
    file,
    key,
    localesDirectory,
    signature,
  );
  return [...signature].sort();
}

async function readLanguagePack(
  localesDirectory: string,
  directoryName: string,
): Promise<LanguagePack> {
  const directory = path.join(localesDirectory, directoryName);
  const entries = await readdir(directory, { withFileTypes: true });
  const actualFiles = entries.map((entry) => entry.name).sort();

  if (
    actualFiles.length !== requiredPackFiles.length ||
    requiredPackFiles.some((file, index) => actualFiles[index] !== file) ||
    entries.some((entry) => !entry.isFile())
  ) {
    const missing = requiredPackFiles.filter((file) => !actualFiles.includes(file));
    const extra = actualFiles.filter((file) => !requiredPackFiles.includes(file));
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
      extra.length > 0 ? `unexpected ${extra.join(", ")}` : "",
    ].filter(Boolean);
    throw new CatalogError(
      directoryName,
      `language pack must contain exactly the required YAML files${details.length > 0 ? ` (${details.join("; ")})` : ""}`,
    );
  }

  const manifest = await readManifest(
    directory,
    directoryName,
    localesDirectory,
  );
  const messages: Record<string, string> = {};
  const sourceFiles: Record<string, string> = {};

  for (const catalogName of catalogNames) {
    const file = path.join(directory, `${catalogName}.yaml`);
    const catalog = await readYaml(file, localesDirectory);
    const flattened: Record<string, string> = {};
    flattenCatalog(catalog, "", file, localesDirectory, flattened);

    for (const [key, message] of Object.entries(flattened)) {
      const qualifiedKey = `${catalogName}.${key}`;
      messages[qualifiedKey] = message;
      sourceFiles[qualifiedKey] = file;
    }
  }

  const signatures = Object.fromEntries(
    Object.entries(messages).map(([key, message]) => [
      key,
      messageSignature(
        message,
        manifest.tag,
        sourceFiles[key],
        key,
        localesDirectory,
      ),
    ]),
  );

  return { directory, manifest, messages, signatures };
}

function comparePackWithEnglish(
  english: LanguagePack,
  candidate: LanguagePack,
  localesDirectory: string,
) {
  const englishKeys = Object.keys(english.messages).sort();
  const candidateKeys = Object.keys(candidate.messages).sort();
  const missing = englishKeys.filter((key) => !(key in candidate.messages));
  const extra = candidateKeys.filter((key) => !(key in english.messages));

  if (missing.length > 0 || extra.length > 0) {
    const details = [
      missing.length > 0 ? `missing keys: ${missing.join(", ")}` : "",
      extra.length > 0 ? `unknown keys: ${extra.join(", ")}` : "",
    ].filter(Boolean);
    throw new CatalogError(
      displayPath(candidate.directory, localesDirectory),
      details.join("; "),
    );
  }

  for (const key of englishKeys) {
    const expected = english.signatures[key];
    const actual = candidate.signatures[key];
    if (expected.join("\n") !== actual.join("\n")) {
      throw new CatalogError(
        displayPath(candidate.directory, localesDirectory),
        `${key} variables or select/component slots do not match English (expected [${expected.join(", ")}], received [${actual.join(", ")}])`,
      );
    }
  }
}

export async function loadCatalogs(
  localesDirectory = defaultLocalesDirectory,
): Promise<CatalogBuild> {
  const entries = await readdir(localesDirectory, { withFileTypes: true });
  const languageDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (languageDirectories.length === 0) {
    throw new CatalogError(localesDirectory, "no language packs found");
  }

  const packs = await Promise.all(
    languageDirectories.map((directory) =>
      readLanguagePack(localesDirectory, directory),
    ),
  );
  const duplicateTags = packs
    .map((pack) => pack.manifest.tag)
    .filter((tag, index, tags) => tags.indexOf(tag) !== index);
  if (duplicateTags.length > 0) {
    throw new CatalogError(
      localesDirectory,
      `duplicate language tag${duplicateTags.length === 1 ? "" : "s"}: ${[...new Set(duplicateTags)].join(", ")}`,
    );
  }

  const english = packs.find((pack) => pack.manifest.tag === "en");
  if (!english) {
    throw new CatalogError(localesDirectory, 'canonical "en" language pack is required');
  }

  for (const pack of packs) {
    if (pack !== english) comparePackWithEnglish(english, pack, localesDirectory);
  }

  return {
    defaultLanguage: "en",
    keys: Object.keys(english.messages).sort(),
    packs: [...packs].sort((left, right) =>
      left.manifest.tag.localeCompare(right.manifest.tag),
    ),
  };
}

function generatedHeader() {
  return "// Generated by `npm run i18n:generate`. Do not edit.\n\n";
}

export function renderGeneratedFiles(build: CatalogBuild) {
  const english = build.packs.find((pack) => pack.manifest.tag === "en");
  if (!english) throw new Error('Canonical "en" language pack is missing');

  const manifests = build.packs.map((pack) => pack.manifest);
  const catalogs = Object.fromEntries(
    build.packs.map((pack) => [
      pack.manifest.tag,
      Object.fromEntries(
        Object.entries(pack.messages).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    ]),
  );
  const parameters = Object.fromEntries(
    build.keys.map((key) => {
      const names = english.signatures[key]
        .map((part) => {
          const [kind, first, second] = part.split(":");
          return kind === "plural" ? second : first;
        })
        .filter(Boolean);
      return [key, [...new Set(names)].sort()];
    }),
  );

  return new Map<string, string>([
    [
      "keys.ts",
      `${generatedHeader()}export const messageKeys = ${JSON.stringify(build.keys, null, 2)} as const;\n\nexport type MessageKey = (typeof messageKeys)[number];\n\nexport const messageParameters = ${JSON.stringify(parameters, null, 2)} as const satisfies Record<MessageKey, readonly string[]>;\n`,
    ],
    [
      "manifests.ts",
      `${generatedHeader()}export const defaultLanguage = ${JSON.stringify(build.defaultLanguage)} as const;\n\nexport const languageManifests = ${JSON.stringify(manifests, null, 2)} as const;\n\nexport type LanguageManifest = (typeof languageManifests)[number];\nexport type LanguageTag = LanguageManifest["tag"];\nexport type TextDirection = LanguageManifest["direction"];\n\nexport const supportedLanguageTags = languageManifests.map((manifest) => manifest.tag) as LanguageTag[];\n`,
    ],
    [
      "catalogs.ts",
      `${generatedHeader()}import type { MessageKey } from "./keys";\nimport type { LanguageTag } from "./manifests";\n\nexport type MessageCatalog = Record<MessageKey, string>;\n\nexport const messageCatalogs = ${JSON.stringify(catalogs, null, 2)} as const satisfies Record<LanguageTag, MessageCatalog>;\n`,
    ],
    [
      "index.ts",
      `${generatedHeader()}export * from "./catalogs";\nexport * from "./keys";\nexport * from "./manifests";\n`,
    ],
  ]);
}

export async function generateCatalogModules(
  localesDirectory = defaultLocalesDirectory,
  generatedDirectory = defaultGeneratedDirectory,
) {
  const build = await loadCatalogs(localesDirectory);
  const files = renderGeneratedFiles(build);
  await mkdir(generatedDirectory, { recursive: true });
  await Promise.all(
    [...files].map(([name, source]) =>
      writeFile(path.join(generatedDirectory, name), source, "utf8"),
    ),
  );
  return build;
}

async function runCli() {
  const command = process.argv[2] ?? "generate";
  if (command !== "generate" && command !== "check") {
    throw new Error(`Unknown i18n command: ${command}`);
  }

  const build =
    command === "generate"
      ? await generateCatalogModules()
      : await loadCatalogs(defaultLocalesDirectory);
  console.log(
    `i18n ${command} passed: ${build.packs.length} language pack${build.packs.length === 1 ? "" : "s"}, ${build.keys.length} messages`,
  );
}

const executedFile = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (executedFile === import.meta.url) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
