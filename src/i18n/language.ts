import {
  defaultLanguage as generatedDefaultLanguage,
  supportedLanguageTags as generatedSupportedLanguageTags,
  type LanguageTag,
} from "@/i18n/generated/manifests";

const SECONDS_PER_DAY = 24 * 60 * 60;

export const UI_LANGUAGE_COOKIE_NAME = "ledgerlab_ui_language";
export const UI_LANGUAGE_COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  maxAge: 400 * SECONDS_PER_DAY,
  path: "/",
  sameSite: "lax" as const,
});

export type AcceptedLanguage = Readonly<{
  tag: string;
  quality: number;
}>;

/** Return the canonical form of one BCP 47 tag, or null for invalid input. */
export function canonicalizeLanguageTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate === "*") return null;

  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Canonicalize and deduplicate configured languages while guaranteeing the
 * generated English fallback remains available.
 */
export function canonicalizeSupportedLanguageTags(
  supportedTags: readonly string[] = generatedSupportedLanguageTags,
): string[] {
  const fallback = canonicalizeLanguageTag(generatedDefaultLanguage) ?? "en";
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of [fallback, ...supportedTags]) {
    const canonical = canonicalizeLanguageTag(value);
    if (!canonical) continue;
    const identity = canonical.toLocaleLowerCase("en-US");
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(canonical);
  }

  return result;
}

export const DEFAULT_UI_LANGUAGE = canonicalizeLanguageTag(generatedDefaultLanguage) ?? "en";
export const SUPPORTED_UI_LANGUAGE_TAGS = Object.freeze(
  canonicalizeSupportedLanguageTags(generatedSupportedLanguageTags),
);

/** Resolve untrusted input to the generated, compile-time language union. */
export function resolveConfiguredUiLanguage(requestedTag: unknown): LanguageTag {
  const resolved = resolveSupportedLanguage(
    requestedTag,
    generatedSupportedLanguageTags,
  );
  return generatedSupportedLanguageTags.includes(resolved as LanguageTag)
    ? resolved as LanguageTag
    : generatedDefaultLanguage;
}

function supportedLanguageMatch(
  requestedTag: unknown,
  supportedTags: readonly string[],
): string | null {
  const requested = canonicalizeLanguageTag(requestedTag);
  if (!requested) return null;

  const supported = canonicalizeSupportedLanguageTags(supportedTags);
  const byIdentity = new Map(
    supported.map((tag) => [tag.toLocaleLowerCase("en-US"), tag] as const),
  );

  const exact = byIdentity.get(requested.toLocaleLowerCase("en-US"));
  if (exact) return exact;

  const baseLanguage = new Intl.Locale(requested).language;
  return byIdentity.get(baseLanguage.toLocaleLowerCase("en-US")) ?? null;
}

/** Resolve one requested tag, preferring an exact match and then its base language. */
export function resolveSupportedLanguage(
  requestedTag: unknown,
  supportedTags: readonly string[] = SUPPORTED_UI_LANGUAGE_TAGS,
): string {
  return supportedLanguageMatch(requestedTag, supportedTags) ?? DEFAULT_UI_LANGUAGE;
}

function parseQuality(parameter: string): number | null {
  const match = /^q\s*=\s*(.+)$/i.exec(parameter.trim());
  if (!match) return null;
  const raw = match[1]?.trim() ?? "";
  if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw)) return null;
  const quality = Number(raw);
  return quality >= 0 && quality <= 1 ? quality : null;
}

/** Parse and order the concrete language ranges in an Accept-Language value. */
export function parseAcceptLanguage(header: string | null | undefined): AcceptedLanguage[] {
  if (!header?.trim()) return [];

  const parsed: Array<AcceptedLanguage & { order: number }> = [];
  for (const [order, entry] of header.split(",").entries()) {
    const [rawRange, ...parameters] = entry.split(";");
    const range = rawRange?.trim() ?? "";
    if (!range) continue;

    let quality = 1;
    let malformed = false;
    let qualitySeen = false;
    for (const parameter of parameters) {
      const trimmed = parameter.trim();
      if (!trimmed) continue;
      if (!/^q\s*=/i.test(trimmed) || qualitySeen) {
        malformed = true;
        break;
      }
      qualitySeen = true;
      const parsedQuality = parseQuality(trimmed);
      if (parsedQuality === null) {
        malformed = true;
        break;
      }
      quality = parsedQuality;
    }
    if (malformed || quality === 0) continue;

    const tag = range === "*" ? "*" : canonicalizeLanguageTag(range);
    if (!tag) continue;
    parsed.push({ tag, quality, order });
  }

  parsed.sort((left, right) => right.quality - left.quality || left.order - right.order);

  const seen = new Set<string>();
  return parsed.flatMap(({ tag, quality }) => {
    const identity = tag.toLocaleLowerCase("en-US");
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ tag, quality }];
  });
}

export type AnonymousLanguageInput = Readonly<{
  cookieLanguage?: string | null;
  acceptLanguage?: string | null;
  supportedTags?: readonly string[];
}>;

export type RequestLanguageInput = AnonymousLanguageInput & Readonly<{
  savedLanguage?: string | null;
}>;

/** Resolve anonymous UI language as cookie, then Accept-Language, then English. */
export function resolveAnonymousLanguage({
  cookieLanguage,
  acceptLanguage,
  supportedTags = SUPPORTED_UI_LANGUAGE_TAGS,
}: AnonymousLanguageInput): string {
  const cookieMatch = supportedLanguageMatch(cookieLanguage, supportedTags);
  if (cookieMatch) return cookieMatch;

  for (const preference of parseAcceptLanguage(acceptLanguage)) {
    if (preference.tag === "*") return DEFAULT_UI_LANGUAGE;
    const match = supportedLanguageMatch(preference.tag, supportedTags);
    if (match) return match;
  }

  return DEFAULT_UI_LANGUAGE;
}

/** A signed-in preference always wins, including a safe English fallback if stale. */
export function resolveRequestLanguage({
  savedLanguage,
  cookieLanguage,
  acceptLanguage,
  supportedTags = SUPPORTED_UI_LANGUAGE_TAGS,
}: RequestLanguageInput): string {
  if (savedLanguage !== null && savedLanguage !== undefined) {
    return resolveSupportedLanguage(savedLanguage, supportedTags);
  }
  return resolveAnonymousLanguage({
    cookieLanguage,
    acceptLanguage,
    supportedTags,
  });
}
