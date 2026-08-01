import { createHash } from "node:crypto";

type RateLimitBucket = {
  attempts: number;
  resetAt: number;
};

declare global {
  var __ledgerLabRateLimitBuckets: Map<string, RateLimitBucket> | undefined;
}

const MAX_BUCKETS = 10_000;
const buckets = globalThis.__ledgerLabRateLimitBuckets ?? new Map<string, RateLimitBucket>();
if (process.env.NODE_ENV !== "production") globalThis.__ledgerLabRateLimitBuckets = buckets;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export function opaqueRateLimitKey(scope: string, ...parts: string[]) {
  const digest = createHash("sha256").update(parts.join("\0"), "utf8").digest("base64url");
  return `${scope}:${digest}`;
}

export function consumeRateLimit(
  key: string,
  options: { maxAttempts: number; windowMs: number },
  now = Date.now(),
): RateLimitResult {
  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new TypeError("maxAttempts must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
    throw new TypeError("windowMs must be a positive safe integer");
  }

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (!bucket && buckets.size >= MAX_BUCKETS) {
      const oldestKey = buckets.keys().next().value as string | undefined;
      if (oldestKey) buckets.delete(oldestKey);
    }
    bucket = { attempts: 0, resetAt: now + options.windowMs };
    buckets.set(key, bucket);
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));
  if (bucket.attempts >= options.maxAttempts) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  bucket.attempts += 1;
  return {
    allowed: true,
    remaining: Math.max(0, options.maxAttempts - bucket.attempts),
    retryAfterSeconds,
  };
}

export function clearRateLimit(key: string) {
  buckets.delete(key);
}
