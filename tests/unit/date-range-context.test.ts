import { describe, expect, it } from "vitest";

import {
  getDateKey,
  getDateRangeLabel,
  getDefaultDateRange,
  getQuickPickRange,
  identifyQuickPick,
  normalizeDateRange,
  validateDateRange,
} from "@/components/date-range-context";

describe("workspace date range helpers", () => {
  it("derives the calendar day in the requested time zone", () => {
    const instant = new Date("2026-07-31T21:30:00.000Z");
    expect(getDateKey(instant, "Europe/Bucharest")).toBe("2026-08-01");
    expect(getDateKey(instant, "America/New_York")).toBe("2026-07-31");
    expect(getDefaultDateRange(instant, "Europe/Bucharest")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("rolls quick picks and active identification over at Bucharest midnight", () => {
    const beforeMidnight = new Date("2026-07-31T20:59:59.999Z");
    const afterMidnight = new Date("2026-07-31T21:00:00.000Z");
    const july = { from: "2026-07-01", to: "2026-07-31" };

    expect(getDateKey(beforeMidnight, "Europe/Bucharest")).toBe("2026-07-31");
    expect(getDateKey(afterMidnight, "Europe/Bucharest")).toBe("2026-08-01");
    expect(getQuickPickRange("this_month", beforeMidnight, "Europe/Bucharest")).toEqual(july);
    expect(getQuickPickRange("this_month", afterMidnight, "Europe/Bucharest")).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(identifyQuickPick(july, beforeMidnight, "Europe/Bucharest")).toBe("this_month");
    expect(identifyQuickPick(july, afterMidnight, "Europe/Bucharest")).toBe("last_month");
  });

  it("crosses a year boundary for last month and rolling calendar-month picks", () => {
    const january = new Date("2026-01-15T10:00:00.000Z");
    expect(getQuickPickRange("last_month", january)).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
    expect(getQuickPickRange("last_3_months", january)).toEqual({
      from: "2025-11-01",
      to: "2026-01-31",
    });
    expect(getQuickPickRange("last_12_months", january)).toEqual({
      from: "2025-02-01",
      to: "2026-01-31",
    });
    expect(getQuickPickRange("next_month", new Date("2025-12-15T10:00:00.000Z"))).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
    });
  });

  it("uses leap-year month ends and Romanian year-to-date bounds", () => {
    const leapFebruary = new Date("2024-02-10T10:00:00.000Z");
    expect(getQuickPickRange("this_month", leapFebruary)).toEqual({
      from: "2024-02-01",
      to: "2024-02-29",
    });
    expect(getQuickPickRange("this_year", leapFebruary)).toEqual({
      from: "2024-01-01",
      to: "2024-02-10",
    });
    expect(getQuickPickRange("month_to_date", leapFebruary)).toEqual({
      from: "2024-02-01",
      to: "2024-02-10",
    });
    expect(getQuickPickRange("last_6_months", leapFebruary)).toEqual({
      from: "2023-09-01",
      to: "2024-02-29",
    });
  });

  it("normalizes valid custom input and rejects missing, impossible, or reversed dates", () => {
    expect(normalizeDateRange({ from: " 2026-05-04 ", to: " 2026-07-19 " })).toEqual({
      from: "2026-05-04",
      to: "2026-07-19",
    });
    expect(validateDateRange({ from: "2026-02-30", to: "2026-03-01" })).toEqual({
      success: false,
      error: "Use valid calendar dates.",
    });
    expect(validateDateRange({ from: "2026-08-01", to: "2026-07-31" })).toEqual({
      success: false,
      error: "The start date must be on or before the end date.",
    });
    expect(normalizeDateRange({ from: "", to: "2026-07-31" })).toBeNull();
    expect(validateDateRange({ from: "2010-01-01", to: "2026-07-31" })).toEqual({
      success: false,
      error: "Choose a date range of ten years or less.",
    });
  });

  it("identifies quick picks and creates compact, human-readable labels", () => {
    const reference = new Date("2026-07-10T10:00:00.000Z");
    expect(identifyQuickPick({ from: "2026-07-01", to: "2026-07-31" }, reference)).toBe(
      "this_month",
    );
    expect(identifyQuickPick({ from: "2026-07-05", to: "2026-07-31" }, reference)).toBe(
      "custom",
    );
    expect(getDateRangeLabel({ from: "2026-07-01", to: "2026-07-31" }, "ro-RO")).toBe("Iulie 2026");
    expect(getDateRangeLabel({ from: "2025-11-01", to: "2026-01-31" }, "ro-RO")).toBe(
      "Noiembrie 2025 – ianuarie 2026",
    );
    expect(getDateRangeLabel({ from: "2026-05-04", to: "2026-07-19" }, "ro-RO")).toBe(
      "4 mai – 19 iul. 2026",
    );
  });
});
