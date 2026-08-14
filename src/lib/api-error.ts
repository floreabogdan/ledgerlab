import type {
  ApiErrorDescriptor,
  ApiErrorEnvelope,
  ApiErrorParameter,
} from "@/lib/api-response";
import { messageKeys, type MessageKey } from "@/i18n/generated";
import type { TranslationValues, Translator } from "@/i18n/runtime";

const API_ERROR_MESSAGE_KEYS = {
  AUTHENTICATION_REQUIRED: "errors.auth.authenticationRequired",
  BAD_REQUEST: "errors.api.badRequest",
  CONFLICT: "errors.api.conflict",
  EMAIL_TAKEN: "errors.auth.emailTaken",
  FORBIDDEN: "errors.api.forbidden",
  INTERNAL_ERROR: "errors.generic.unexpected",
  INVALID_CONTENT_LENGTH: "errors.api.invalidContentLength",
  INVALID_CREDENTIALS: "errors.auth.invalidCredentials",
  INVALID_CURRENCY: "errors.auth.invalidCurrency",
  INVALID_EMAIL: "errors.auth.invalidEmail",
  INVALID_JSON: "errors.api.invalidJson",
  INVALID_LOCALE: "errors.auth.invalidLocale",
  INVALID_TIME_ZONE: "errors.auth.invalidTimeZone",
  METHOD_NOT_ALLOWED: "errors.api.methodNotAllowed",
  NOT_FOUND: "errors.api.notFound",
  PAYLOAD_TOO_LARGE: "errors.api.payloadTooLarge",
  RATE_LIMITED: "errors.api.rateLimited",
  REGISTRATION_CLOSED: "errors.auth.registrationClosed",
  REQUEST_FAILED: "errors.generic.unexpected",
  UNSUPPORTED_MEDIA_TYPE: "errors.api.unsupportedMediaType",
  VALIDATION_FAILED: "errors.generic.validation",
  WEAK_PASSWORD: "errors.auth.weakPassword",
  VALIDATION_INVALID_FORMAT: "errors.validationIssues.invalidFormat",
  VALIDATION_INVALID_TYPE: "errors.validationIssues.invalidType",
  VALIDATION_TOO_BIG: "errors.validationIssues.tooBig",
  VALIDATION_TOO_SMALL: "errors.validationIssues.tooSmall",
  VALIDATION_CUSTOM: "errors.validationIssues.custom",
} as const satisfies Record<string, MessageKey>;

const KNOWN_MESSAGE_KEYS = new Set<string>(messageKeys);

function isMessageKey(value: string): value is MessageKey {
  return KNOWN_MESSAGE_KEYS.has(value);
}

function codeMessageSegment(code: string) {
  return code
    .toLowerCase()
    .replaceAll(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parameters(value: unknown) {
  if (!isRecord(value)) return undefined;
  const result: Record<string, ApiErrorParameter> = {};
  for (const [key, parameter] of Object.entries(value)) {
    if (
      parameter === null ||
      typeof parameter === "string" ||
      typeof parameter === "number" ||
      typeof parameter === "boolean"
    ) {
      result[key] = parameter;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseApiError(value: unknown): ApiErrorDescriptor | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.error) ? value.error : value;
  if (
    typeof candidate.code !== "string" ||
    !/^[A-Z][A-Z0-9_]*$/.test(candidate.code)
  ) {
    return null;
  }

  const issues = Array.isArray(candidate.issues)
    ? candidate.issues.flatMap((issue) => {
        if (!isRecord(issue) || typeof issue.code !== "string") return [];
        const path = Array.isArray(issue.path)
          ? issue.path.filter(
              (segment): segment is string | number =>
                typeof segment === "string" || typeof segment === "number",
            )
          : [];
        return [{ code: issue.code, path, params: parameters(issue.params) }];
      })
    : undefined;

  return {
    code: candidate.code,
    params: parameters(candidate.params),
    issues,
  };
}

export function apiErrorEnvelope(error: ApiErrorDescriptor): ApiErrorEnvelope {
  return { error };
}

export function apiErrorMessageKey(code: string): MessageKey {
  const catalogCodeKey = `errors.codes.${codeMessageSegment(code)}`;
  if (isMessageKey(catalogCodeKey)) return catalogCodeKey;

  const exact = API_ERROR_MESSAGE_KEYS[code as keyof typeof API_ERROR_MESSAGE_KEYS];
  if (exact) return exact;

  for (const suffix of [
    "BAD_REQUEST",
    "CONFLICT",
    "NOT_FOUND",
    "VALIDATION_FAILED",
  ] as const) {
    if (code.endsWith(`_${suffix}`)) {
      return API_ERROR_MESSAGE_KEYS[suffix];
    }
  }
  return "errors.generic.unexpected";
}

export function translateApiError(
  translator: Translator,
  error: ApiErrorDescriptor | null | undefined,
) {
  if (!error) return translator.translate("errors.generic.unexpected");
  const key = apiErrorMessageKey(error.code);
  const translate = translator.translate as (
    messageKey: MessageKey,
    values?: TranslationValues,
  ) => string;
  return translate(key, error.params);
}
