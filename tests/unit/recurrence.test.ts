import { describe, expect, it } from "vitest";

import { nextOccurrence, occurrencesBetween } from "@/lib/domain/recurrence";

describe("deterministic recurrence", () => {
  it("clamps month-end across leap-year and ordinary February", () => {
    expect(
      occurrencesBetween(
        { frequency: "monthly", startDate: "2024-01-31", dayOfMonth: 31, adjustment: "clamp" },
        "2024-01-01",
        "2024-04-30",
      ),
    ).toEqual(["2024-01-31", "2024-02-29", "2024-03-31", "2024-04-30"]);
    expect(
      occurrencesBetween(
        { frequency: "monthly", startDate: "2025-01-31", dayOfMonth: 31, adjustment: "clamp" },
        "2025-02-01",
        "2025-02-28",
      ),
    ).toEqual(["2025-02-28"]);
  });

  it("can skip invalid month days and prevents duplicate materialization", () => {
    expect(
      occurrencesBetween(
        { frequency: "monthly", startDate: "2024-01-31", dayOfMonth: 31, adjustment: "skip" },
        "2024-01-01",
        "2024-04-30",
        ["2024-01-31", "2024-03-31"],
      ),
    ).toEqual([]);
  });

  it("handles yearly leap-day and count boundaries", () => {
    expect(
      occurrencesBetween(
        { frequency: "yearly", startDate: "2024-02-29", occurrenceCount: 3, adjustment: "clamp" },
        "2024-01-01",
        "2030-12-31",
      ),
    ).toEqual(["2024-02-29", "2025-02-28", "2026-02-28"]);
  });

  it("keeps interval weeks deterministic across a year boundary", () => {
    expect(
      occurrencesBetween(
        { frequency: "weekly", interval: 2, startDate: "2025-12-29", daysOfWeek: [1, 5] },
        "2025-12-29",
        "2026-01-31",
      ),
    ).toEqual(["2025-12-29", "2026-01-02", "2026-01-12", "2026-01-16", "2026-01-26", "2026-01-30"]);
    expect(nextOccurrence({ frequency: "monthly", startDate: "2026-01-31" }, "2026-01-31")).toBe("2026-02-28");
  });
});

