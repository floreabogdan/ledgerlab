import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    public headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function jsonError(error: unknown) {
  if (error instanceof HttpError) {
    return NextResponse.json(
      { error: error.message, details: error.details },
      { status: error.status, headers: error.headers },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: "Please correct the highlighted fields", details: error.flatten() },
      { status: 422 },
    );
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "The request body is not valid JSON" }, { status: 400 });
  }
  console.error(error);
  return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}

const DEFAULT_JSON_BODY_BYTES = 2 * 1024 * 1024;

function bodyTooLarge(maxBytes: number) {
  const limit = maxBytes < 1024 * 1024
    ? `${Math.ceil(maxBytes / 1024)} KB`
    : `${Math.ceil(maxBytes / (1024 * 1024))} MB`;
  return new HttpError(413, `The request body must not exceed ${limit}`);
}

export async function readJson(request: Request, maxBytes = DEFAULT_JSON_BODY_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }

  const contentLength = request.headers.get("content-length")?.trim();
  if (contentLength) {
    if (!/^\d+$/.test(contentLength)) throw new HttpError(400, "Content-Length must be a non-negative integer");
    if (BigInt(contentLength) > BigInt(maxBytes)) throw bodyTooLarge(maxBytes);
  }

  try {
    if (!request.body) throw new SyntaxError("Missing request body");

    const reader = request.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = [];
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size error is more useful than a transport cancellation error.
        }
        throw bodyTooLarge(maxBytes);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join("")) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The request body is not valid JSON");
  }
}
