import { describe, expect, it } from "vitest";

import { clearRateLimit, consumeRateLimit, opaqueRateLimitKey } from "@/lib/rate-limit";

describe("process-local authentication rate limits", () => {
  it("allows a bounded number of attempts and resets after the window", () => {
    const key = opaqueRateLimitKey("test", "person@example.test", "192.0.2.1");
    clearRateLimit(key);
    const options = { maxAttempts: 2, windowMs: 60_000 };

    expect(consumeRateLimit(key, options, 1_000)).toMatchObject({ allowed: true, remaining: 1 });
    expect(consumeRateLimit(key, options, 2_000)).toMatchObject({ allowed: true, remaining: 0 });
    expect(consumeRateLimit(key, options, 3_000)).toMatchObject({ allowed: false, retryAfterSeconds: 58 });
    expect(consumeRateLimit(key, options, 61_000)).toMatchObject({ allowed: true, remaining: 1 });
    clearRateLimit(key);
  });

  it("uses opaque keys and supports clearing a successful identity bucket", () => {
    const identity = "person@example.test";
    const key = opaqueRateLimitKey("test-clear", identity);
    expect(key).not.toContain(identity);
    consumeRateLimit(key, { maxAttempts: 1, windowMs: 60_000 }, 1_000);
    expect(consumeRateLimit(key, { maxAttempts: 1, windowMs: 60_000 }, 2_000).allowed).toBe(false);
    clearRateLimit(key);
    expect(consumeRateLimit(key, { maxAttempts: 1, windowMs: 60_000 }, 2_000).allowed).toBe(true);
    clearRateLimit(key);
  });
});
