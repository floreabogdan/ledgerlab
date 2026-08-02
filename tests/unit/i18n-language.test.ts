import { describe, expect, it } from "vitest";

import {
  canonicalizeLanguageTag,
  canonicalizeSupportedLanguageTags,
  DEFAULT_UI_LANGUAGE,
  parseAcceptLanguage,
  resolveAnonymousLanguage,
  resolveRequestLanguage,
  resolveSupportedLanguage,
  UI_LANGUAGE_COOKIE_NAME,
  UI_LANGUAGE_COOKIE_OPTIONS,
} from "@/i18n/language";

const supported = ["en", "ro", "pt", "pt-BR"] as const;

describe("UI language configuration", () => {
  it("exports a long-lived site-wide language cookie", () => {
    expect(UI_LANGUAGE_COOKIE_NAME).toBe("ledgerlab_ui_language");
    expect(UI_LANGUAGE_COOKIE_OPTIONS).toMatchObject({
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
    expect(UI_LANGUAGE_COOKIE_OPTIONS.maxAge).toBeGreaterThanOrEqual(365 * 24 * 60 * 60);
  });

  it("canonicalizes and deduplicates valid supported BCP 47 tags", () => {
    expect(canonicalizeLanguageTag(" PT-br ")).toBe("pt-BR");
    expect(canonicalizeLanguageTag("not_a_tag")).toBeNull();
    expect(canonicalizeSupportedLanguageTags(["EN", "pt-br", "ro", "PT-BR", "bad_tag"]))
      .toEqual(["en", "pt-BR", "ro"]);
  });
});

describe("supported language matching", () => {
  it("uses a supported base language for a regional request", () => {
    expect(resolveSupportedLanguage("ro-RO", supported)).toBe("ro");
  });

  it("prefers an exact supported tag over its supported base language", () => {
    expect(resolveSupportedLanguage("pt-BR", supported)).toBe("pt-BR");
    expect(resolveSupportedLanguage("pt-PT", supported)).toBe("pt");
  });

  it("falls back deterministically for invalid, unsupported, or removed tags", () => {
    expect(resolveSupportedLanguage("not_a_tag", ["ro", "pt-BR"])).toBe(DEFAULT_UI_LANGUAGE);
    expect(resolveSupportedLanguage("fr-FR", supported)).toBe("en");
    expect(resolveSupportedLanguage("ro", ["en"])).toBe("en");
  });
});

describe("Accept-Language parsing", () => {
  it("orders by quality and preserves header order for equal weights", () => {
    expect(parseAcceptLanguage("en;q=0.4, ro-RO;q=0.9, pt-BR;q=0.9")).toEqual([
      { tag: "ro-RO", quality: 0.9 },
      { tag: "pt-BR", quality: 0.9 },
      { tag: "en", quality: 0.4 },
    ]);
  });

  it("ignores malformed and zero-quality entries without throwing", () => {
    expect(parseAcceptLanguage("@@@;q=1, ro;q=oops, fr;q=0, pt-br;q=0.8, de;q=.7, en;q=1.2"))
      .toEqual([{ tag: "pt-BR", quality: 0.8 }]);
    expect(parseAcceptLanguage("ro;q=0.8;q=0.7, en;unknown=1")).toEqual([]);
  });

  it("retains a valid wildcard for deterministic fallback", () => {
    expect(parseAcceptLanguage("fr, *;q=0.8, ro;q=0.7")).toEqual([
      { tag: "fr", quality: 1 },
      { tag: "*", quality: 0.8 },
      { tag: "ro", quality: 0.7 },
    ]);
  });
});

describe("anonymous language resolution", () => {
  it("gives a supported cookie precedence over Accept-Language", () => {
    expect(resolveAnonymousLanguage({
      cookieLanguage: "pt-br",
      acceptLanguage: "ro-RO, en;q=0.8",
      supportedTags: supported,
    })).toBe("pt-BR");
  });

  it("ignores an invalid cookie and uses the best supported header language", () => {
    expect(resolveAnonymousLanguage({
      cookieLanguage: "not_a_tag",
      acceptLanguage: "fr-FR, ro-RO;q=0.9, en;q=0.5",
      supportedTags: supported,
    })).toBe("ro");
  });

  it("uses wildcard as the deterministic English fallback", () => {
    expect(resolveAnonymousLanguage({
      acceptLanguage: "fr-FR, *;q=0.8, ro;q=0.7",
      supportedTags: supported,
    })).toBe("en");
    expect(resolveAnonymousLanguage({
      acceptLanguage: "*;q=0, ro-RO;q=0.7",
      supportedTags: supported,
    })).toBe("ro");
  });

  it("falls back to English when no input can be matched", () => {
    expect(resolveAnonymousLanguage({
      cookieLanguage: "ro",
      acceptLanguage: "fr-FR;q=bogus, de-DE",
      supportedTags: ["en"],
    })).toBe("en");
    expect(resolveAnonymousLanguage({ supportedTags: ["pt-BR", "ro"] })).toBe("en");
  });

  it("gives a saved account preference precedence over a stale cookie", () => {
    expect(resolveRequestLanguage({
      savedLanguage: "ro",
      cookieLanguage: "pt-BR",
      acceptLanguage: "en",
      supportedTags: supported,
    })).toBe("ro");
    expect(resolveRequestLanguage({
      savedLanguage: "removed-language",
      cookieLanguage: "ro",
      supportedTags: supported,
    })).toBe("en");
  });
});
