import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
import { getRequestI18nContext } from "@/i18n/request-context";
import { createServerTranslator } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const i18n = await getRequestI18nContext();
  return { title: createServerTranslator(i18n).translate("auth.metadata.registerTitle") };
}

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
