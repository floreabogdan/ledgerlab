import type { ReactNode } from "react";
import Link from "next/link";
import { getRequestI18nContext } from "@/i18n/request-context";
import { createServerTranslator } from "@/i18n/server";

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const i18n = await getRequestI18nContext();
  const t = createServerTranslator(i18n).translate;

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <Link className="auth-brand" href="/" aria-label={t("auth.layout.homeAria")}>
          <span className="brand-mark" aria-hidden="true">L</span>
          <span className="brand-name">{t("common.app.name")}</span>
        </Link>
        {children}
        <p className="auth-footnote">{t("auth.layout.footnote")}</p>
      </section>
      <aside className="auth-aside" aria-label={t("auth.layout.aboutAria")}>
        <div className="auth-aside-content">
          <span className="auth-aside-label">{t("auth.layout.eyebrow")}</span>
          <h2>{t("auth.layout.headline")}</h2>
          <p>{t("auth.layout.description")}</p>
          <div className="auth-preview" aria-label={t("auth.layout.previewAria")}>
            <div className="auth-preview-item"><span>{t("auth.layout.preview.cashLabel")}</span><strong>{t("auth.layout.preview.cashValue")}</strong></div>
            <div className="auth-preview-item"><span>{t("auth.layout.preview.dueLabel")}</span><strong>{t("auth.layout.preview.paymentCount", { count: 0 })}</strong></div>
            <div className="auth-preview-item"><span>{t("auth.layout.preview.forecastLabel")}</span><strong>{t("auth.layout.preview.notPlanned")}</strong></div>
          </div>
        </div>
      </aside>
    </main>
  );
}
