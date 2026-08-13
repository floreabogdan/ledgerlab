import { describe, expect, it } from "vitest";

import { messageCatalogs } from "@/i18n/generated";
import { createTranslator } from "@/i18n/runtime";
import {
  apiErrorMessageKey,
  parseApiError,
  translateApiError,
} from "@/lib/api-error";

const english = createTranslator({
  language: "en",
  formattingLocale: "en-US",
  catalog: messageCatalogs.en,
});

const romanian = createTranslator({
  language: "ro",
  formattingLocale: "ro-RO",
  catalog: messageCatalogs.ro,
  fallbackCatalog: messageCatalogs.en,
});

describe("localized API errors", () => {
  it("parses stable codes, safe parameters, and field paths", () => {
    expect(parseApiError({
      error: {
        code: "VALIDATION_FAILED",
        params: { accepted: true, nested: { hidden: "value" } },
        issues: [{
          code: "VALIDATION_TOO_SMALL",
          path: ["rows", 2, "amountMinor", { hidden: "value" }],
          params: { minimum: 1 },
        }],
      },
    })).toEqual({
      code: "VALIDATION_FAILED",
      params: { accepted: true },
      issues: [{
        code: "VALIDATION_TOO_SMALL",
        path: ["rows", 2, "amountMinor"],
        params: { minimum: 1 },
      }],
    });
  });

  it("discovers code-specific catalog messages without a manual code map", () => {
    expect(apiErrorMessageKey("IMPORT_ROW_LIMIT_EXCEEDED"))
      .toBe("errors.codes.importRowLimitExceeded");
    expect(translateApiError(english, {
      code: "IMPORT_ROW_LIMIT_EXCEEDED",
      params: { maxRows: 10_000 },
    })).toBe("One import is limited to 10,000 rows. Split the CSV into smaller files before importing.");
  });

  it("renders parameterized and selected error branches in Romanian", () => {
    const importLimit = translateApiError(romanian, {
      code: "IMPORT_ROW_LIMIT_EXCEEDED",
      params: { maxRows: 10_000 },
    });
    expect(importLimit).toContain("10.000");
    expect(importLimit).not.toContain("One import");

    expect(translateApiError(romanian, {
      code: "QUERY_DATE_RANGE_TOO_LONG",
      params: { maxYears: 2 },
    })).toContain("2 ani");
    expect(translateApiError(romanian, {
      code: "QUERY_DATE_RANGE_TOO_LONG",
      params: { maxYears: 20 },
    })).toContain("20 de ani");
    expect(translateApiError(romanian, {
      code: "LIABILITY_PAYMENT_CADENCE_INTERVAL_MISMATCH",
      params: { frequency: "monthly" },
    })).toContain("lunară");
  });

  it("never presents legacy diagnostics, malformed codes, or unknown codes", () => {
    expect(parseApiError({ message: "Private database diagnostic" })).toBeNull();
    expect(parseApiError({ error: { code: "invalid code" } })).toBeNull();

    const translated = translateApiError(english, parseApiError({
      error: { code: "UNRECOGNIZED_SERVER_FAILURE", diagnostic: "Sensitive detail" },
    }));
    expect(translated).toBe("Something went wrong. Please try again.");
    expect(translated).not.toContain("UNRECOGNIZED");
    expect(translated).not.toContain("Sensitive");

    const romanianFallback = translateApiError(romanian, {
      code: "UNRECOGNIZED_SERVER_FAILURE",
    });
    expect(romanianFallback).not.toBe("Something went wrong. Please try again.");
    expect(romanianFallback).not.toContain("UNRECOGNIZED");
  });
});
