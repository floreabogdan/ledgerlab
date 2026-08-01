import { describe, expect, it } from "vitest";

import {
  currencyMinorToInput,
  currencyMinorUnitDigits,
  parseCurrencyAmountToMinor,
} from "@/lib/domain/currency";
import {
  COMMON_CURRENCY_CODES,
  DEFAULT_CURRENCY,
  currencyCatalog,
  isSupportedCurrency,
} from "@/lib/currencies";
import { registerInput } from "@/lib/validation";

describe("ISO currency catalog", () => {
  it("ranks common currencies first while retaining the complete runtime catalog", () => {
    const catalog = currencyCatalog("en-US");
    expect(catalog.length).toBeGreaterThan(150);
    expect(catalog.slice(0, COMMON_CURRENCY_CODES.length).map((item) => item.code))
      .toEqual([...COMMON_CURRENCY_CODES]);
    expect(catalog.find((item) => item.code === "USD")).toMatchObject({
      name: "US Dollar",
      minorUnitDigits: 2,
      common: true,
    });
    expect(isSupportedCurrency(" ron ")).toBe(true);
    expect(isSupportedCurrency("ZZZ")).toBe(false);
  });

  it("defaults registration to USD but accepts a supported user selection", () => {
    const base = { name: "Test User", email: "test@example.test", password: "long-enough-password" };
    expect(registerInput.parse(base)).toMatchObject({
      currency: DEFAULT_CURRENCY,
      locale: "en-US",
      timeZone: "UTC",
    });
    expect(registerInput.parse({ ...base, currency: "ron", locale: "ro-RO", timeZone: "Europe/Bucharest" }))
      .toMatchObject({ currency: "RON", locale: "ro-RO", timeZone: "Europe/Bucharest" });
    expect(registerInput.safeParse({ ...base, currency: "ZZZ" }).success).toBe(false);
  });
});

describe("currency minor-unit precision", () => {
  it("uses ISO precision for RON, JPY, and KWD", () => {
    expect(currencyMinorUnitDigits("RON")).toBe(2);
    expect(currencyMinorUnitDigits("jpy")).toBe(0);
    expect(currencyMinorUnitDigits(" KWD ")).toBe(3);
  });

  it("falls back to two digits for malformed or private currency codes", () => {
    expect(currencyMinorUnitDigits("not-a-code")).toBe(2);
    expect(currencyMinorUnitDigits("ZZZ")).toBe(2);
  });
});

describe("currency amount parsing", () => {
  it("parses dot or comma decimals and preserves signs for RON", () => {
    expect(parseCurrencyAmountToMinor("12.34", "RON")).toBe(1_234);
    expect(parseCurrencyAmountToMinor(" 12,34 ", "RON")).toBe(1_234);
    expect(parseCurrencyAmountToMinor("-12,34", "RON")).toBe(-1_234);
  });

  it("honors zero- and three-decimal currencies", () => {
    expect(parseCurrencyAmountToMinor("1000", "JPY")).toBe(1_000);
    expect(parseCurrencyAmountToMinor("1.0", "JPY")).toBeNull();
    expect(parseCurrencyAmountToMinor("1.234", "KWD")).toBe(1_234);
    expect(parseCurrencyAmountToMinor("-1,234", "KWD")).toBe(-1_234);
  });

  it("rejects excess precision, malformed input, and unsafe integers", () => {
    expect(parseCurrencyAmountToMinor("1.234", "RON")).toBeNull();
    expect(parseCurrencyAmountToMinor("1.2345", "KWD")).toBeNull();
    expect(parseCurrencyAmountToMinor("RON 12.00", "RON")).toBeNull();
    expect(parseCurrencyAmountToMinor("9007199254740992", "RON")).toBeNull();
  });
});

describe("currency input formatting", () => {
  it("formats exact editable values without locale grouping", () => {
    expect(currencyMinorToInput(1_234, "RON")).toBe("12.34");
    expect(currencyMinorToInput(-1_234, "RON")).toBe("-12.34");
    expect(currencyMinorToInput(1_000, "JPY")).toBe("1000");
    expect(currencyMinorToInput(1_234, "KWD")).toBe("1.234");
  });

  it("refuses unsafe integer minor-unit values", () => {
    expect(currencyMinorToInput(Number.MAX_SAFE_INTEGER + 1, "RON")).toBe("");
  });
});
