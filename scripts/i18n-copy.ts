import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import { i18nCopyAllowlist, type I18nCopyAllowlistEntry } from "./i18n-copy-allowlist";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoots = [
  path.join(repositoryRoot, "src", "app"),
  path.join(repositoryRoot, "src", "components"),
];

const PRESENTATION_ATTRIBUTES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "caption",
  "description",
  "emptydescription",
  "emptytitle",
  "error",
  "eyebrow",
  "help",
  "hint",
  "info",
  "label",
  "listboxlabel",
  "message",
  "notice",
  "placeholder",
  "searchplaceholder",
  "subtitle",
  "success",
  "text",
  "title",
  "warning",
]);

const PRESENTATION_PROPERTIES = new Set([
  "caption",
  "description",
  "detail",
  "disclaimer",
  "error",
  "eyebrow",
  "help",
  "hint",
  "info",
  "label",
  "message",
  "notice",
  "subtitle",
  "success",
  "text",
  "title",
  "warning",
]);

const PRESENTATION_NAME_SUFFIX =
  /(?:caption|description|error|eyebrow|help|hint|info|label|message|notice|placeholder|subtitle|success|text|title|warning)$/;

const PRESENTATION_SETTER =
  /^set(?:[A-Z][A-Za-z0-9]*)?(?:Error|Feedback|Message|Notice|Success|Warning)$/;

export type HardcodedCopyViolation = Readonly<{
  file: string;
  line: number;
  column: number;
  kind: string;
  text: string;
}>;

export type InvalidI18nCopyAllowlistEntry = Readonly<{
  entry: I18nCopyAllowlistEntry;
  problem: string;
}>;

function normalizedText(value: string) {
  return value.replaceAll(/\s+/g, " ").trim();
}

function looksLikePresentation(value: string) {
  const text = normalizedText(value);
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(text)) return false;
  if (/^%[A-Za-z]$/.test(text)) return false;
  return /\p{L}/u.test(text);
}

function presentationName(
  name: string,
  knownNames: ReadonlySet<string>,
) {
  const normalized = name.toLowerCase();
  return knownNames.has(normalized)
    || (!normalized.endsWith("key") && PRESENTATION_NAME_SUFFIX.test(normalized));
}

function propertyNameText(name: ts.PropertyName | undefined) {
  if (!name) return "";
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return "";
}

function directCallName(expression: ts.Expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return "";
}

export function findHardcodedCopy(
  source: string,
  file = "fixture.tsx",
): HardcodedCopyViolation[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: HardcodedCopyViolation[] = [];
  const seen = new Set<string>();

  function report(node: ts.Node, kind: string, value: string) {
    const text = normalizedText(value);
    if (!looksLikePresentation(text)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const identity = `${position.line}:${position.character}:${kind}:${text}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    violations.push({
      file,
      line: position.line + 1,
      column: position.character + 1,
      kind,
      text,
    });
  }

  function renderedCallbackNames(
    callback: ts.ArrowFunction | ts.FunctionExpression,
  ) {
    const names = new Set<string>();

    function visit(candidate: ts.Node) {
      if (
        candidate !== callback.body
        && (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))
      ) return;
      if (
        ts.isJsxExpression(candidate)
        && candidate.expression
        && ts.isIdentifier(candidate.expression)
      ) {
        const parent = candidate.parent;
        if (
          !ts.isJsxAttribute(parent)
          || presentationName(
            parent.name.getText(sourceFile),
            PRESENTATION_ATTRIBUTES,
          )
        ) names.add(candidate.expression.text);
      }
      if (
        ts.isReturnStatement(candidate)
        && candidate.expression
        && ts.isIdentifier(candidate.expression)
      ) names.add(candidate.expression.text);
      ts.forEachChild(candidate, visit);
    }

    if (ts.isIdentifier(callback.body)) names.add(callback.body.text);
    else visit(callback.body);
    return names;
  }

  function unwrapExpression(node: ts.Expression): ts.Expression {
    if (
      ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node)
      || ts.isTypeAssertionExpression(node)
    ) return unwrapExpression(node.expression);
    return node;
  }

  function reportMappedValues(
    receiver: ts.Expression,
    callback: ts.ArrowFunction | ts.FunctionExpression,
    kind: string,
  ) {
    const renderedNames = renderedCallbackNames(callback);
    const parameter = callback.parameters[0]?.name;
    if (!parameter || renderedNames.size === 0) return;

    if (ts.isIdentifier(parameter)) {
      if (renderedNames.has(parameter.text)) {
        reportPresentationExpression(receiver, kind);
      }
      return;
    }
    if (!ts.isArrayBindingPattern(parameter)) return;

    const rows = unwrapExpression(receiver);
    if (!ts.isArrayLiteralExpression(rows)) return;
    for (const row of rows.elements) {
      const values = unwrapExpression(row);
      if (!ts.isArrayLiteralExpression(values)) continue;
      parameter.elements.forEach((binding, index) => {
        if (
          ts.isBindingElement(binding)
          && ts.isIdentifier(binding.name)
          && renderedNames.has(binding.name.text)
          && values.elements[index]
        ) reportPresentationExpression(values.elements[index], kind);
      });
    }
  }

  function reportPresentationExpression(node: ts.Expression, kind: string) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      report(node, kind, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const staticText = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
      report(node, kind, staticText);
      return;
    }
    if (ts.isParenthesizedExpression(node)) {
      reportPresentationExpression(node.expression, kind);
      return;
    }
    if (
      ts.isAsExpression(node)
      || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node)
      || ts.isTypeAssertionExpression(node)
    ) {
      reportPresentationExpression(node.expression, kind);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      reportPresentationExpression(node.whenTrue, kind);
      reportPresentationExpression(node.whenFalse, kind);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        reportPresentationExpression(element, kind);
      }
      return;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      reportPresentationExpression(node.expression, kind);
      return;
    }
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (method === "join") {
          reportPresentationExpression(node.expression.expression, kind);
        }
        if (method === "map" || method === "flatMap") {
          for (const argument of node.arguments) {
            if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) continue;
            const callback = argument;
            const callbackBody = callback.body;
            reportMappedValues(node.expression.expression, callback, kind);
            if (!ts.isBlock(callbackBody)) {
              reportPresentationExpression(callbackBody, kind);
              continue;
            }
            function visitReturns(candidate: ts.Node) {
              if (
                candidate !== callbackBody
                && (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))
              ) return;
              if (ts.isReturnStatement(candidate) && candidate.expression) {
                reportPresentationExpression(candidate.expression, kind);
                return;
              }
              ts.forEachChild(candidate, visitReturns);
            }
            visitReturns(callbackBody);
          }
        }
      }
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken
        || operator === ts.SyntaxKind.BarBarToken
        || operator === ts.SyntaxKind.QuestionQuestionToken
        || operator === ts.SyntaxKind.PlusToken
      ) {
        reportPresentationExpression(node.left, kind);
        reportPresentationExpression(node.right, kind);
      }
    }
  }

  function visit(node: ts.Node) {
    if (ts.isJsxText(node)) {
      report(node, "JSX text", node.getText(sourceFile));
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile).toLowerCase();
      if (presentationName(name, PRESENTATION_ATTRIBUTES) && node.initializer) {
        if (ts.isJsxExpression(node.initializer)) {
          if (node.initializer.expression) {
            reportPresentationExpression(node.initializer.expression, `JSX ${name}`);
          }
        } else {
          reportPresentationExpression(node.initializer, `JSX ${name}`);
        }
      }
    } else if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression) {
      reportPresentationExpression(node.expression, "JSX expression");
    } else if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression)) {
      if (node.expression.expression.getText(sourceFile) === "Error") {
        const value = node.expression.arguments?.[0];
        if (value) reportPresentationExpression(value, "client error");
      }
    } else if (
      ts.isCallExpression(node)
      && PRESENTATION_SETTER.test(directCallName(node.expression))
      && node.arguments[0]
    ) {
      reportPresentationExpression(node.arguments[0], "state message");
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyNameText(node.name).toLowerCase();
      if (presentationName(name, PRESENTATION_PROPERTIES)) {
        reportPresentationExpression(node.initializer, `object ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(resolved);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [resolved] : [];
  }));
  return nested.flat();
}

function allowlistIdentity(entry: Pick<I18nCopyAllowlistEntry, "file" | "text">) {
  return `${entry.file.replaceAll("\\", "/")}\0${normalizedText(entry.text)}`;
}

export async function checkHardcodedCopy(
  roots: readonly string[] = sourceRoots,
  allowlist: readonly I18nCopyAllowlistEntry[] = i18nCopyAllowlist,
) {
  const files = (await Promise.all(roots.map(sourceFiles))).flat().sort();
  const allowed = new Map<string, I18nCopyAllowlistEntry>();
  const invalidAllowlist: InvalidI18nCopyAllowlistEntry[] = [];
  for (const entry of allowlist) {
    const identity = allowlistIdentity(entry);
    if (!entry.reason.trim()) {
      invalidAllowlist.push({ entry, problem: "reason must not be blank" });
      continue;
    }
    if (allowed.has(identity)) {
      invalidAllowlist.push({
        entry,
        problem: "duplicate file and text identity",
      });
      continue;
    }
    allowed.set(identity, entry);
  }
  const used = new Set<string>();
  const violations: HardcodedCopyViolation[] = [];

  for (const absoluteFile of files) {
    const file = path.relative(repositoryRoot, absoluteFile).replaceAll(path.sep, "/");
    const source = await readFile(absoluteFile, "utf8");
    for (const violation of findHardcodedCopy(source, file)) {
      const identity = allowlistIdentity(violation);
      if (allowed.has(identity)) used.add(identity);
      else violations.push(violation);
    }
  }

  const staleAllowlist = [...allowed.values()].filter(
    (entry) => !used.has(allowlistIdentity(entry)),
  );
  return { violations, staleAllowlist, invalidAllowlist };
}

async function main() {
  const result = await checkHardcodedCopy();
  for (const violation of result.violations) {
    console.error(`${violation.file}:${violation.line}:${violation.column} ${violation.kind}: ${JSON.stringify(violation.text)}`);
  }
  for (const entry of result.staleAllowlist) {
    console.error(`stale i18n copy allowlist entry in ${entry.file}: ${JSON.stringify(entry.text)}`);
  }
  for (const invalid of result.invalidAllowlist) {
    console.error(`invalid i18n copy allowlist entry in ${invalid.entry.file}: ${invalid.problem}`);
  }
  if (
    result.violations.length
    || result.staleAllowlist.length
    || result.invalidAllowlist.length
  ) process.exitCode = 1;
  else console.log(`i18n copy check passed: ${result.violations.length} unapproved literals`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
