import "server-only";

import {
  defaultLanguage,
  languageManifests,
  messageCatalogs,
  type LanguageManifest,
  type LanguageTag,
  type MessageCatalog,
} from "@/i18n/generated";
import { createTranslator } from "@/i18n/runtime";

const catalogCache = new Map<LanguageTag, MessageCatalog>();

export interface I18nPagePayload {
  language: LanguageTag;
  direction: LanguageManifest["direction"];
  catalog: MessageCatalog;
}

export function getLanguageManifest(language: LanguageTag): LanguageManifest {
  return (
    languageManifests.find((manifest) => manifest.tag === language) ??
    languageManifests.find((manifest) => manifest.tag === defaultLanguage) ??
    languageManifests[0]
  );
}

export function getMessageCatalog(language: LanguageTag): MessageCatalog {
  const cached = catalogCache.get(language);
  if (cached) return cached;

  const english = messageCatalogs[defaultLanguage];
  const selected = messageCatalogs[language] ?? english;
  const catalog = Object.freeze({ ...english, ...selected }) as MessageCatalog;
  catalogCache.set(language, catalog);
  return catalog;
}

export function getI18nPagePayload(language: LanguageTag): I18nPagePayload {
  const manifest = getLanguageManifest(language);
  return {
    language: manifest.tag,
    direction: manifest.direction,
    catalog: getMessageCatalog(manifest.tag),
  };
}

export function createServerTranslator({
  language,
  formattingLocale,
  timeZone,
}: {
  language: LanguageTag;
  formattingLocale: string;
  timeZone?: string;
}) {
  const manifest = getLanguageManifest(language);
  return createTranslator({
    language: manifest.tag,
    direction: manifest.direction,
    formattingLocale,
    timeZone,
    catalog: getMessageCatalog(manifest.tag),
    fallbackCatalog: getMessageCatalog(defaultLanguage),
    fallbackLanguage: defaultLanguage,
  });
}
