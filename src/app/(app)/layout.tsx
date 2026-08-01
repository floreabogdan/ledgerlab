import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { ensureDatabase } from "@/db";
import { SESSION_COOKIE_NAME, validateSessionToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  ensureDatabase();
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!validateSessionToken(token)) redirect("/login");
  return children;
}
