import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { I18nProvider } from "@/i18n/client";
import { getRequestI18nContext } from "@/i18n/request-context";
import { createServerTranslator } from "@/i18n/server";
import "./globals.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const i18n = await getRequestI18nContext();
  const t = createServerTranslator(i18n).translate;

  return {
    title: {
      default: t("common.app.name"),
      template: t("common.metadata.titleTemplate", { title: "%s" }),
    },
    description: t("common.metadata.description"),
  };
}

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const i18n = await getRequestI18nContext();

  return (
    <html lang={i18n.language} dir={i18n.direction} data-scroll-behavior="smooth">
      <body>
        <I18nProvider
          language={i18n.language}
          direction={i18n.direction}
          catalog={i18n.catalog}
          formattingLocale={i18n.formattingLocale}
          timeZone={i18n.timeZone}
        >
          <AppShell>{children}</AppShell>
        </I18nProvider>
      </body>
    </html>
  );
}
