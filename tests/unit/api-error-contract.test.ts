import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { messageCatalogs } from "@/i18n/generated";
import { apiErrorMessageKey } from "@/lib/api-error";

type CodeSegment =
  | { literal: string }
  | { parameter: number };

type CodePattern = CodeSegment[];

interface FunctionInfo {
  key: string;
  name: string;
  parameters: ReadonlyMap<string, number>;
}

interface SourceInfo {
  filePath: string;
  relativePath: string;
  sourceFile: ts.SourceFile;
  httpErrorNames: ReadonlySet<string>;
  functions: ReadonlyMap<ts.FunctionLikeDeclaration, FunctionInfo>;
}

interface HttpErrorEvent {
  source: SourceInfo;
  node: ts.NewExpression;
  container?: FunctionInfo;
}

interface FactoryCallEvent {
  source: SourceInfo;
  node: ts.CallExpression;
  calleeName: string;
  container?: FunctionInfo;
}

const projectRoot = process.cwd();
const apiErrorSourcePath = path.join(projectRoot, "src", "lib", "api-error.ts");

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesBelow(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

const contractSourcePaths = [
  ...sourceFilesBelow(path.join(projectRoot, "src", "server")),
  path.join(projectRoot, "src", "app", "api", "[...path]", "route.ts"),
].sort();

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (propertyNameText(property.name) !== propertyName) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
  }
  return undefined;
}

function isFunctionImplementation(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node);
}

function functionName(node: ts.FunctionLikeDeclaration) {
  if (
    (ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node))
    && node.name
  ) {
    return propertyNameText(node.name);
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && ts.isVariableDeclaration(node.parent)
  ) {
    return propertyNameText(node.parent.name);
  }
  return undefined;
}

function parseSource(filePath: string): SourceInfo {
  const sourceFile = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const relativePath = path.relative(projectRoot, filePath).replaceAll(path.sep, "/");
  const httpErrorNames = new Set<string>();
  const functions = new Map<ts.FunctionLikeDeclaration, FunctionInfo>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@/lib/api-response"
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "HttpError") {
        httpErrorNames.add(element.name.text);
      }
    }
  }

  const visit = (node: ts.Node) => {
    if (isFunctionImplementation(node)) {
      const name = functionName(node);
      if (name) {
        const parameters = new Map<string, number>();
        node.parameters.forEach((parameter, index) => {
          if (ts.isIdentifier(parameter.name)) parameters.set(parameter.name.text, index);
        });
        functions.set(node, {
          key: `${relativePath}:${name}`,
          name,
          parameters,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { filePath, relativePath, sourceFile, httpErrorNames, functions };
}

const sources = contractSourcePaths.map(parseSource);

function containingFunction(source: SourceInfo, node: ts.Node) {
  let current = node.parent;
  while (current) {
    if (isFunctionImplementation(current)) return source.functions.get(current);
    current = current.parent;
  }
  return undefined;
}

function isHttpErrorConstruction(source: SourceInfo, node: ts.NewExpression) {
  const target = unwrapExpression(node.expression);
  return ts.isIdentifier(target) && source.httpErrorNames.has(target.text);
}

const httpErrorEvents: HttpErrorEvent[] = [];
const callEvents: FactoryCallEvent[] = [];

for (const source of sources) {
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && isHttpErrorConstruction(source, node)) {
      httpErrorEvents.push({
        source,
        node,
        container: containingFunction(source, node),
      });
    }
    if (ts.isCallExpression(node)) {
      const target = unwrapExpression(node.expression);
      if (ts.isIdentifier(target)) {
        callEvents.push({
          source,
          node,
          calleeName: target.text,
          container: containingFunction(source, node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source.sourceFile);
}

function combinePatterns(left: CodePattern[], right: CodePattern[]): CodePattern[] {
  return left.flatMap((leftPattern) =>
    right.map((rightPattern) => normalizePattern([...leftPattern, ...rightPattern]))
  );
}

function normalizePattern(pattern: CodePattern): CodePattern {
  const normalized: CodePattern = [];
  for (const segment of pattern) {
    const previous = normalized.at(-1);
    if ("literal" in segment && previous && "literal" in previous) {
      previous.literal += segment.literal;
    } else {
      normalized.push({ ...segment });
    }
  }
  return normalized;
}

function expressionPatterns(
  rawExpression: ts.Expression,
  parameters: ReadonlyMap<string, number>,
): CodePattern[] {
  const expression = unwrapExpression(rawExpression);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [[{ literal: expression.text }]];
  }
  if (ts.isIdentifier(expression)) {
    const parameter = parameters.get(expression.text);
    return parameter === undefined ? [] : [[{ parameter }]];
  }
  if (ts.isTemplateExpression(expression)) {
    let patterns: CodePattern[] = [[{ literal: expression.head.text }]];
    for (const span of expression.templateSpans) {
      const substitution = expressionPatterns(span.expression, parameters);
      if (substitution.length === 0) return [];
      patterns = combinePatterns(patterns, substitution);
      patterns = combinePatterns(patterns, [[{ literal: span.literal.text }]]);
    }
    return patterns;
  }
  if (
    ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = expressionPatterns(expression.left, parameters);
    const right = expressionPatterns(expression.right, parameters);
    return left.length > 0 && right.length > 0 ? combinePatterns(left, right) : [];
  }
  if (ts.isConditionalExpression(expression)) {
    return [
      ...expressionPatterns(expression.whenTrue, parameters),
      ...expressionPatterns(expression.whenFalse, parameters),
    ];
  }
  return [];
}

function patternKey(pattern: CodePattern) {
  return JSON.stringify(pattern);
}

function staticCode(pattern: CodePattern) {
  if (pattern.some((segment) => "parameter" in segment)) return undefined;
  return pattern.map((segment) => "literal" in segment ? segment.literal : "").join("");
}

function substituteFactoryPattern(
  pattern: CodePattern,
  call: ts.CallExpression,
  callerParameters: ReadonlyMap<string, number>,
) {
  let patterns: CodePattern[] = [[]];
  for (const segment of pattern) {
    if ("literal" in segment) {
      patterns = combinePatterns(patterns, [[segment]]);
      continue;
    }
    const argument = call.arguments[segment.parameter];
    if (!argument) return [];
    const replacements = expressionPatterns(argument, callerParameters);
    if (replacements.length === 0) return [];
    patterns = combinePatterns(patterns, replacements);
  }
  return patterns;
}

function sourceLocation(source: SourceInfo, node: ts.Node) {
  const { line, character } = source.sourceFile.getLineAndCharacterOfPosition(
    node.getStart(source.sourceFile),
  );
  return `${source.relativePath}:${line + 1}:${character + 1}`;
}

function collectExplicitCodes() {
  const codes = new Set<string>();
  const invalidCodes = new Set<string>();
  const factoryPatterns = new Map<string, Map<string, CodePattern>>();

  const addResolvedPattern = (container: FunctionInfo | undefined, pattern: CodePattern) => {
    const code = staticCode(pattern);
    if (code !== undefined) {
      if (/^[A-Z][A-Z0-9_]*$/.test(code)) codes.add(code);
      else invalidCodes.add(code);
      return false;
    }
    if (!container) return false;
    const patterns = factoryPatterns.get(container.key) ?? new Map<string, CodePattern>();
    const key = patternKey(pattern);
    if (patterns.has(key)) return false;
    patterns.set(key, pattern);
    factoryPatterns.set(container.key, patterns);
    return true;
  };

  for (const event of httpErrorEvents) {
    const descriptor = event.node.arguments?.[1];
    if (!descriptor) continue;
    const unwrapped = unwrapExpression(descriptor);
    if (!ts.isObjectLiteralExpression(unwrapped)) continue;
    const code = objectProperty(unwrapped, "code");
    if (!code) continue;
    const parameters = event.container?.parameters ?? new Map<string, number>();
    for (const pattern of expressionPatterns(code, parameters)) {
      addResolvedPattern(event.container, pattern);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const event of callEvents) {
      const targetKey = `${event.source.relativePath}:${event.calleeName}`;
      const targetPatterns = factoryPatterns.get(targetKey);
      if (!targetPatterns) continue;
      const callerParameters = event.container?.parameters ?? new Map<string, number>();
      for (const targetPattern of targetPatterns.values()) {
        for (const pattern of substituteFactoryPattern(
          targetPattern,
          event.node,
          callerParameters,
        )) {
          if (addResolvedPattern(event.container, pattern)) changed = true;
        }
      }
    }
  }

  return {
    codes: [...codes].sort(),
    invalidCodes: [...invalidCodes].sort(),
  };
}

function builtInErrorMessageKeys() {
  const sourceFile = ts.createSourceFile(
    apiErrorSourcePath,
    readFileSync(apiErrorSourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const result = new Map<string, string>();

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "API_ERROR_MESSAGE_KEYS"
      && node.initializer
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(initializer)) {
        for (const property of initializer.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const code = propertyNameText(property.name);
          const messageKey = unwrapExpression(property.initializer);
          if (code && ts.isStringLiteral(messageKey)) result.set(code, messageKey.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function codeMessageSegment(code: string) {
  return code
    .toLowerCase()
    .replaceAll(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

describe("API error contract", () => {
  it("constructs every HttpError with an explicit descriptor", () => {
    const violations: string[] = [];
    for (const event of httpErrorEvents) {
      const descriptor = event.node.arguments?.[1];
      const unwrapped = descriptor ? unwrapExpression(descriptor) : undefined;
      if (!unwrapped || !ts.isObjectLiteralExpression(unwrapped)) {
        const kind = unwrapped
          ? ts.SyntaxKind[unwrapped.kind]
          : "missing second argument";
        violations.push(
          `${sourceLocation(event.source, event.node)} uses ${kind}; pass { code, message, ... }`,
        );
        continue;
      }
      if (!objectProperty(unwrapped, "code") || !objectProperty(unwrapped, "message")) {
        violations.push(
          `${sourceLocation(event.source, event.node)} must declare both code and diagnostic message fields`,
        );
      }
    }

    expect(
      violations,
      `Legacy HttpError overloads expose diagnostic prose instead of a stable localizable code:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("maps every statically declared HttpError code to English copy", () => {
    const { codes, invalidCodes } = collectExplicitCodes();
    const builtIns = builtInErrorMessageKeys();
    const englishCatalog = messageCatalogs.en as Readonly<Record<string, string>>;
    const failures = invalidCodes.map((code) =>
      `Invalid explicit HttpError code ${JSON.stringify(code)}; use UPPER_SNAKE_CASE`
    );

    for (const code of codes) {
      const expectedKey = builtIns.get(code)
        ?? `errors.codes.${codeMessageSegment(code)}`;
      const resolvedKey = apiErrorMessageKey(code);
      const message = englishCatalog[expectedKey];
      if (resolvedKey !== expectedKey) {
        failures.push(`${code} resolves to ${resolvedKey}; add ${expectedKey}`);
      } else if (!message?.trim()) {
        failures.push(`${code} resolves to ${expectedKey}, but its English message is missing or empty`);
      }
    }

    expect(codes.length).toBeGreaterThan(0);
    expect(
      failures,
      `Every explicit HttpError code needs code-specific English copy or an entry in API_ERROR_MESSAGE_KEYS:\n${failures.join("\n")}`,
    ).toEqual([]);
  });
});
