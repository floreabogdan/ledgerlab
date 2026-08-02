import "server-only";

import { cache } from "react";
import { cookies, headers } from "next/headers";

import {
  resolveConfiguredUiLanguage,
  resolveRequestLanguage,
  UI_LANGUAGE_COOKIE_NAME,
} from "@/i18n/language";
import { getI18nPagePayload } from "@/i18n/server";
import { DEFAULT_LOCALE, DEFAULT_TIME_ZONE } from "@/lib/currencies";
import { getRequestSession } from "@/lib/request-session";

export const getRequestI18nContext = cache(async () => {
  const [cookieStore, headerStore, session] = await Promise.all([
    cookies(),
    headers(),
    getRequestSession(),
  ]);
  const requestedLanguage = resolveRequestLanguage({
    savedLanguage: session?.user.uiLanguage,
    cookieLanguage: cookieStore.get(UI_LANGUAGE_COOKIE_NAME)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });
  const language = resolveConfiguredUiLanguage(requestedLanguage);

  return {
    ...getI18nPagePayload(language),
    formattingLocale: session?.user.locale ?? DEFAULT_LOCALE,
    timeZone: session?.user.timeZone ?? DEFAULT_TIME_ZONE,
  };
});
