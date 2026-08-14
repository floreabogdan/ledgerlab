import type { Metadata } from "next";

import { InvitationForm } from "@/components/invitation-form";
import { getRequestI18nContext } from "@/i18n/request-context";
import { createServerTranslator } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const i18n = await getRequestI18nContext();
  return { title: createServerTranslator(i18n).translate("auth.metadata.invitationTitle") };
}

export default async function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <InvitationForm token={token} />;
}
