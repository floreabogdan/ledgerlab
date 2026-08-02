import { describe, expect, it } from "vitest";

import { messageCatalogs } from "@/i18n/generated/catalogs";
import {
  createTranslator,
  type RuntimeMessageCatalog,
  type TranslationValues,
} from "@/i18n/runtime";

const englishCatalog = messageCatalogs.en;

function translator(
  language: string,
  catalog: RuntimeMessageCatalog,
  formattingLocale = "en-US",
) {
  return createTranslator({
    language,
    formattingLocale,
    direction: "ltr",
    catalog,
    fallbackCatalog: englishCatalog,
  });
}

describe("universal translation runtime", () => {
  it("formats English one and other cardinal plurals", () => {
    const english = translator("en", englishCatalog);

    expect(english.translate("common.items.count", { count: 1 })).toBe("1 item");
    expect(english.translate("common.items.count", { count: 2 })).toBe("2 items");
  });

  it("formats Romanian one, few, and other cardinal plurals", () => {
    const romanian = translator("ro", {
      "common.items.count":
        "{count, plural, one {# element} few {# elemente} other {# de elemente}}",
    });

    expect(romanian.translate("common.items.count", { count: 1 })).toBe("1 element");
    expect(romanian.translate("common.items.count", { count: 2 })).toBe("2 elemente");
    expect(romanian.translate("common.items.count", { count: 20 })).toBe("20 de elemente");
  });

  it("supports named interpolation and select branches", () => {
    const selected = translator("en", {
      "common.welcome.named":
        "Hello {name}; access is {role, select, owner {full} viewer {read-only} other {limited}}.",
    });

    expect(selected.translate("common.welcome.named", {
      name: "Ana",
      role: "owner",
    })).toBe("Hello Ana; access is full.");
    expect(selected.translate("common.welcome.named", {
      name: "Mihai",
      role: "viewer",
    })).toBe("Hello Mihai; access is read-only.");
    expect(selected.translate("common.welcome.named", {
      name: "Ioana",
      role: "guest",
    })).toBe("Hello Ioana; access is limited.");
  });

  it("falls back to English and never exposes an unknown or missing key", () => {
    const romanian = translator("ro", {});
    expect(romanian.translate("common.actions.save")).toBe("Save");

    const withoutFallback = createTranslator({
      language: "ro",
      catalog: {},
      fallbackCatalog: {},
    });
    const runtimeLookup = withoutFallback.translate as unknown as (
      key: string,
      values?: TranslationValues,
    ) => string;
    const result = runtimeLookup("missing.catalog.key");

    expect(result).toBe("Something went wrong. Please try again.");
    expect(result).not.toContain("missing.catalog.key");
  });

  it("reports a missing selected-language message once", () => {
    const missing: string[] = [];
    const romanian = createTranslator({
      language: "ro",
      catalog: {},
      fallbackCatalog: englishCatalog,
      onMissingMessage: (key) => missing.push(key),
    });

    expect(romanian.translate("common.actions.save")).toBe("Save");
    expect(romanian.translate("common.actions.save")).toBe("Save");
    expect(missing).toEqual(["common.actions.save"]);
  });

  it("formats component slots as caller-owned values without emitting markup", () => {
    type LinkToken = { type: "link"; text: string };
    const rich = translator("en", {
      "common.welcome.named":
        "Review <termsLink>the terms</termsLink> before continuing.",
    });

    const result = rich.rich<LinkToken, "common.welcome.named">(
      "common.welcome.named",
      {},
      {
        termsLink: (parts) => ({
          type: "link",
          text: parts.join(""),
        }),
      },
    );

    expect(result).toEqual([
      "Review ",
      { type: "link", text: "the terms" },
      " before continuing.",
    ]);
    expect(result.filter((part): part is string => typeof part === "string").join(""))
      .not.toContain("<termsLink>");

    const unsafe = translator("en", {
      "common.actions.save": "<script>alert(1)</script>",
    });
    expect(unsafe.rich("common.actions.save", {}, {})).toEqual(["Save"]);
  });

  it("uses Romanian plural rules while formatting numbers with the formatting locale", () => {
    const romanianWithEnglishNumbers = translator(
      "ro",
      {
        "common.items.count":
          "{count, plural, one {# element} few {# elemente} other {# de elemente}}",
      },
      "en-US",
    );

    expect(romanianWithEnglishNumbers.translate("common.items.count", { count: 2 }))
      .toBe("2 elemente");
    expect(romanianWithEnglishNumbers.translate("common.items.count", { count: 1234 }))
      .toBe("1,234 de elemente");
  });

  it("keeps compiled-message caches isolated across interleaved translators", () => {
    const sharedMessage =
      "{count, plural, one {one} few {few} other {other}}";
    const english = translator("en", { "common.items.count": sharedMessage });
    const romanian = translator("ro", { "common.items.count": sharedMessage });

    expect(english.translate("common.items.count", { count: 2 })).toBe("other");
    expect(romanian.translate("common.items.count", { count: 2 })).toBe("few");
    expect(english.translate("common.items.count", { count: 1 })).toBe("one");
    expect(romanian.translate("common.items.count", { count: 20 })).toBe("other");
    expect(english.translate("common.items.count", { count: 2 })).toBe("other");
  });
});
