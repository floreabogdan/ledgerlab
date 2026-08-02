import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getRequestSession } from "@/lib/request-session";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  if (!(await getRequestSession())) redirect("/login");
  return children;
}
