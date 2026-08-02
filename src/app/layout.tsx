import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { defaultLanguage } from "@/i18n/generated";
import { I18nProvider } from "@/i18n/client";
import { getI18nPagePayload } from "@/i18n/server";
import { DEFAULT_LOCALE, DEFAULT_TIME_ZONE } from "@/lib/currencies";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "LedgerLab",
    template: "%s · LedgerLab",
  },
  description: "A focused personal finance workspace for planning, liabilities, and multi-currency transaction tracking.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const i18n = getI18nPagePayload(defaultLanguage);

  return (
    <html lang={i18n.language} dir={i18n.direction} data-scroll-behavior="smooth">
      <body>
        <I18nProvider
          language={i18n.language}
          direction={i18n.direction}
          catalog={i18n.catalog}
          formattingLocale={DEFAULT_LOCALE}
          timeZone={DEFAULT_TIME_ZONE}
        >
          <AppShell>{children}</AppShell>
        </I18nProvider>
      </body>
    </html>
  );
}
