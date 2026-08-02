"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";

import type {
  LanguageTag,
  MessageCatalog,
  TextDirection,
} from "@/i18n/generated";
import { createTranslator, type Translator } from "@/i18n/runtime";

const I18nContext = createContext<Translator | null>(null);

export interface I18nProviderProps {
  children: ReactNode;
  language: LanguageTag;
  direction: TextDirection;
  catalog: MessageCatalog;
  formattingLocale: string;
  timeZone?: string;
}

export function I18nProvider({
  children,
  language,
  direction,
  catalog,
  formattingLocale,
  timeZone,
}: I18nProviderProps) {
  const translator = useMemo(
    () =>
      createTranslator({
        language,
        direction,
        catalog,
        fallbackCatalog: catalog,
        formattingLocale,
        timeZone,
      }),
    [catalog, direction, formattingLocale, language, timeZone],
  );

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = direction;
  }, [direction, language]);

  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

export function useTranslator() {
  const translator = useContext(I18nContext);
  if (!translator) {
    throw new Error("useTranslator must be used within an I18nProvider");
  }
  return translator;
}

export function useTranslations() {
  return useTranslator().translate;
}
