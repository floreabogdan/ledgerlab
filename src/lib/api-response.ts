import { NextResponse } from "next/server";
import { ZodError, type ZodIssue } from "zod";

export type ApiErrorParameter = string | number | boolean | null;
export type ApiErrorParameters = Readonly<Record<string, ApiErrorParameter>>;

export interface ApiValidationIssue {
  code: string;
  path: Array<string | number>;
  params?: ApiErrorParameters;
}

export interface ApiErrorDescriptor {
  code: string;
  params?: ApiErrorParameters;
  issues?: ApiValidationIssue[];
}

export interface ApiErrorEnvelope {
  error: ApiErrorDescriptor;
}

export interface HttpErrorOptions {
  code: string;
  /** Language-neutral named values that are safe to return to the caller. */
  params?: ApiErrorParameters;
  /** Internal diagnostic text. It is logged when appropriate, never presented. */
  message: string;
  /** Internal structured context retained for server-side handling and tests. */
  details?: unknown;
  headers?: Record<string, string>;
}

function defaultHttpErrorCode(status: number) {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "AUTHENTICATION_REQUIRED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 405:
      return "METHOD_NOT_ALLOWED";
    case 409:
      return "CONFLICT";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    case 422:
      return "VALIDATION_FAILED";
    case 429:
      return "RATE_LIMITED";
    default:
      return status >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED";
  }
}

function stableErrorCode(value: string, fallback: string) {
  return /^[A-Z][A-Z0-9_]*$/.test(value) ? value : fallback;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly params?: ApiErrorParameters;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;
  readonly hasExplicitCode: boolean;

  constructor(
    status: number,
    messageOrOptions: string | HttpErrorOptions,
    legacyDetails?: unknown,
    legacyHeaders?: Record<string, string>,
  ) {
    const fallbackCode = defaultHttpErrorCode(status);
    const options: HttpErrorOptions = typeof messageOrOptions === "string"
      ? {
          code: fallbackCode,
          message: messageOrOptions,
          details: legacyDetails,
          headers: legacyHeaders,
        }
      : messageOrOptions;
    super(options.message);
    this.name = "HttpError";
    this.status = status;
    this.code = stableErrorCode(options.code, fallbackCode);
    this.params = options.params;
    this.details = options.details;
    this.headers = options.headers;
    this.hasExplicitCode = typeof messageOrOptions !== "string";
  }
}

function publicHttpErrorCode(error: HttpError, domain?: string) {
  if (error.hasExplicitCode || !domain) return error.code;
  const prefixable = new Set([
    "BAD_REQUEST",
    "CONFLICT",
    "NOT_FOUND",
    "VALIDATION_FAILED",
  ]);
  if (!prefixable.has(error.code)) return error.code;
  const normalizedDomain = domain
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  return normalizedDomain ? `${normalizedDomain}_${error.code}` : error.code;
}

function issueParameters(issue: ZodIssue): ApiErrorParameters | undefined {
  const source = issue as unknown as Record<string, unknown>;
  const parameters: Record<string, ApiErrorParameter> = {};
  for (const key of [
    "expected",
    "format",
    "inclusive",
    "maximum",
    "minimum",
    "origin",
    "received",
  ]) {
    const value = source[key];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      parameters[key] = value;
    }
  }
  return Object.keys(parameters).length > 0 ? parameters : undefined;
}

function validationIssues(error: ZodError): ApiValidationIssue[] {
  return error.issues.map((issue) => ({
    code: `VALIDATION_${issue.code.toUpperCase()}`,
    path: issue.path.filter(
      (segment): segment is string | number =>
        typeof segment === "string" || typeof segment === "number",
    ),
    params: issueParameters(issue),
  }));
}

export function jsonError(error: unknown, context?: { domain?: string }) {
  if (error instanceof HttpError) {
    if (error.status >= 500) console.error(error);
    return NextResponse.json<ApiErrorEnvelope>(
      {
        error: {
          code: publicHttpErrorCode(error, context?.domain),
          params: error.params,
        },
      },
      { status: error.status, headers: error.headers },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json<ApiErrorEnvelope>(
      {
        error: {
          code: "VALIDATION_FAILED",
          issues: validationIssues(error),
        },
      },
      { status: 422 },
    );
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json<ApiErrorEnvelope>(
      { error: { code: "INVALID_JSON" } },
      { status: 400 },
    );
  }
  console.error(error);
  return NextResponse.json<ApiErrorEnvelope>(
    { error: { code: "INTERNAL_ERROR" } },
    { status: 500 },
  );
}

const DEFAULT_JSON_BODY_BYTES = 2 * 1024 * 1024;

function bodyTooLarge(maxBytes: number) {
  const maxKilobytes = Math.ceil(maxBytes / 1024);
  return new HttpError(413, {
    code: "PAYLOAD_TOO_LARGE",
    message: `The request body must not exceed ${maxKilobytes} KB`,
    params: { maxKilobytes },
  });
}

export async function readJson(request: Request, maxBytes = DEFAULT_JSON_BODY_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }

  const contentLength = request.headers.get("content-length")?.trim();
  if (contentLength) {
    if (!/^\d+$/.test(contentLength)) {
      throw new HttpError(400, {
        code: "INVALID_CONTENT_LENGTH",
        message: "Content-Length must be a non-negative integer",
      });
    }
    if (BigInt(contentLength) > BigInt(maxBytes)) throw bodyTooLarge(maxBytes);
  }

  try {
    if (!request.body) throw new SyntaxError("Missing request body");

    const reader = request.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = [];
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size error is more useful than a transport cancellation error.
        }
        throw bodyTooLarge(maxBytes);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join("")) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, {
      code: "INVALID_JSON",
      message: "The request body is not valid JSON",
    });
  }
}
