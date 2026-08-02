import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";

import { ensureDatabase } from "@/db";
import {
  SESSION_COOKIE_NAME,
  validateSessionToken,
} from "@/lib/auth";

/** One request-local session lookup shared by the root and authenticated layouts. */
export const getRequestSession = cache(async () => {
  ensureDatabase();
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  return validateSessionToken(token);
});
