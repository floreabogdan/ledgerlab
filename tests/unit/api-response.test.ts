import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { jsonError, HttpError } from "@/lib/api-response";

describe("structured API errors", () => {
  it("returns stable codes and named parameters without diagnostic prose", async () => {
    const response = jsonError(new HttpError(429, {
      code: "RATE_LIMITED",
      message: "Internal English diagnostic that must stay on the server",
      params: { retryAfterSeconds: 30 },
      headers: { "Retry-After": "30" },
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    const body = await response.json();
    expect(body).toEqual({
      error: { code: "RATE_LIMITED", params: { retryAfterSeconds: 30 } },
    });
    expect(JSON.stringify(body)).not.toContain("Internal English diagnostic");
  });

  it("adds a stable endpoint domain to legacy status errors", async () => {
    const response = jsonError(
      new HttpError(404, "Internal attachment diagnostic"),
      { domain: "attachments" },
    );
    expect(await response.json()).toEqual({
      error: { code: "ATTACHMENTS_NOT_FOUND" },
    });
  });

  it("retains exact validation paths without returning Zod messages", async () => {
    const schema = z.object({
      recurrence: z.object({ interval: z.number().int().min(1) }),
    });
    const error = schema.safeParse({ recurrence: { interval: 0 } }).error!;
    const response = jsonError(error);
    const body = await response.json();

    expect(body).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        issues: [{
          code: "VALIDATION_TOO_SMALL",
          path: ["recurrence", "interval"],
          params: { minimum: 1 },
        }],
      },
    });
    expect(JSON.stringify(body)).not.toContain("Too small");
  });

  it("logs unknown diagnostics but returns only a generic code", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = jsonError(new Error("database connection secret"));
      expect(await response.json()).toEqual({ error: { code: "INTERNAL_ERROR" } });
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
