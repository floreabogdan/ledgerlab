import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "LedgerLab",
    template: "%s · LedgerLab",
  },
  description: "A focused personal finance workspace for planning, liabilities, and multi-currency transaction tracking.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
