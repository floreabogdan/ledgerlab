import {
  IntlMessageFormat,
  type FormatXMLElementFn,
  type Formatters,
  type PrimitiveType,
} from "intl-messageformat";

import type { MessageCatalog } from "@/i18n/generated/catalogs";
import {
  messageParameters,
  type MessageKey,
} from "@/i18n/generated/keys";

const GENERIC_ERROR_KEY = "errors.generic.unexpected" satisfies MessageKey;
const LAST_RESORT_MESSAGE = "Something went wrong. Please try again.";

export type TextDirection = "ltr" | "rtl";
export type RuntimeMessageCatalog = Readonly<Partial<MessageCatalog>>;
export type TranslationValue = PrimitiveType;
export type TranslationValues = Readonly<Record<string, TranslationValue>>;

type KnownParameter<Key extends MessageKey> =
  (typeof messageParameters)[Key][number];

export type TranslationArguments<Key extends MessageKey> =
  [KnownParameter<Key>] extends [never]
    ? [values?: TranslationValues]
    : [
        values: TranslationValues & {
          readonly [Parameter in KnownParameter<Key>]: TranslationValue;
        },
      ];

export type RichTextSlot<Value> = FormatXMLElementFn<Value, Value>;

export interface CreateTranslatorOptions {
  /** Locale used for message selection and plural rules. */
  language: string;
  /** Locale used exclusively for number and date presentation. */
  formattingLocale?: string;
  timeZone?: string;
  direction?: TextDirection;
  catalog: RuntimeMessageCatalog;
  fallbackCatalog?: RuntimeMessageCatalog;
  fallbackLanguage?: string;
  onMissingMessage?: (key: MessageKey) => void;
}

export interface Translator {
  readonly language: string;
  readonly formattingLocale: string;
  readonly timeZone: string | undefined;
  readonly direction: TextDirection;
  translate<Key extends MessageKey>(
    key: Key,
    ...arguments_: TranslationArguments<Key>
  ): string;
  rich<Value, Key extends MessageKey>(
    key: Key,
    values: TranslationValues,
    slots: Readonly<Record<string, RichTextSlot<Value>>>,
  ): Array<string | Value>;
}

interface MessageCandidate {
  message: string;
  pluralLocale: string;
}

function canonicalLocale(value: string | undefined, fallback: string): string {
  if (!value?.trim()) return fallback;
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? fallback;
  } catch {
    return fallback;
  }
}

function optionsKey(options: object | undefined): string {
  return JSON.stringify(options ?? {});
}

function createFormatters(
  language: string,
  formattingLocale: string,
  timeZone: string | undefined,
): Formatters {
  const numbers = new Map<string, Intl.NumberFormat>();
  const dates = new Map<string, Intl.DateTimeFormat>();
  const plurals = new Map<string, Intl.PluralRules>();

  return {
    getNumberFormat(_locales, options) {
      const key = optionsKey(options);
      let formatter = numbers.get(key);
      if (!formatter) {
        formatter = new Intl.NumberFormat(
          formattingLocale,
          options as Intl.NumberFormatOptions,
        );
        numbers.set(key, formatter);
      }
      return formatter;
    },
    getDateTimeFormat(_locales, options) {
      const resolvedOptions = timeZone
        ? { ...options, timeZone }
        : options;
      const key = optionsKey(resolvedOptions);
      let formatter = dates.get(key);
      if (!formatter) {
        formatter = new Intl.DateTimeFormat(formattingLocale, resolvedOptions);
        dates.set(key, formatter);
      }
      return formatter;
    },
    getPluralRules(locales, options) {
      const resolvedLocales = locales ?? language;
      const key = `${Array.isArray(resolvedLocales) ? resolvedLocales.join(",") : resolvedLocales}:${optionsKey(options)}`;
      let formatter = plurals.get(key);
      if (!formatter) {
        formatter = new Intl.PluralRules(resolvedLocales, options);
        plurals.set(key, formatter);
      }
      return formatter;
    },
  };
}

function catalogMessage(
  catalog: RuntimeMessageCatalog,
  key: string,
): string | undefined {
  if (!Object.hasOwn(catalog, key)) return undefined;
  const message = (catalog as Readonly<Record<string, string | undefined>>)[key];
  return message?.trim() ? message : undefined;
}

/**
 * Creates a request/provider-local translator. It has no mutable global locale,
 * and its compiled-message and Intl formatter caches cannot cross translators.
 */
export function createTranslator(options: CreateTranslatorOptions): Translator {
  const fallbackLanguage = canonicalLocale(
    options.fallbackLanguage,
    "en",
  );
  const language = canonicalLocale(options.language, fallbackLanguage);
  const formattingLocale = canonicalLocale(
    options.formattingLocale,
    language,
  );
  const fallbackCatalog = options.fallbackCatalog ?? {};
  const formatters = createFormatters(
    language,
    formattingLocale,
    options.timeZone,
  );
  const compiledMessages = new Map<string, IntlMessageFormat>();
  const reportedMissingMessages = new Set<MessageKey>();

  function reportMissingMessage(key: MessageKey) {
    if (catalogMessage(options.catalog, key) || reportedMissingMessages.has(key)) {
      return;
    }
    reportedMissingMessages.add(key);
    if (options.onMissingMessage) {
      options.onMissingMessage(key);
    } else if (process.env.NODE_ENV !== "production") {
      console.warn(`Missing ${language} translation for ${key}; using English fallback.`);
    }
  }

  function candidates(key: string): MessageCandidate[] {
    const result: MessageCandidate[] = [];
    const seen = new Set<string>();

    function add(
      catalog: RuntimeMessageCatalog,
      candidateKey: string,
      pluralLocale: string,
    ) {
      const message = catalogMessage(catalog, candidateKey);
      if (!message) return;
      const identity = `${pluralLocale}\u0000${message}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      result.push({ message, pluralLocale });
    }

    add(options.catalog, key, language);
    add(fallbackCatalog, key, fallbackLanguage);
    if (key !== GENERIC_ERROR_KEY) {
      add(options.catalog, GENERIC_ERROR_KEY, language);
      add(fallbackCatalog, GENERIC_ERROR_KEY, fallbackLanguage);
    }
    result.push({
      message: LAST_RESORT_MESSAGE,
      pluralLocale: fallbackLanguage,
    });
    return result;
  }

  function compiled(candidate: MessageCandidate): IntlMessageFormat {
    const key = `${candidate.pluralLocale}\u0000${candidate.message}`;
    let formatter = compiledMessages.get(key);
    if (!formatter) {
      formatter = new IntlMessageFormat(
        candidate.message,
        candidate.pluralLocale,
        undefined,
        { formatters, ignoreTag: false },
      );
      compiledMessages.set(key, formatter);
    }
    return formatter;
  }

  function translate<Key extends MessageKey>(
    key: Key,
    ...arguments_: TranslationArguments<Key>
  ): string {
    reportMissingMessage(key);
    const values = arguments_[0] ?? {};
    for (const candidate of candidates(key)) {
      try {
        const result = compiled(candidate).format<never>({ ...values });
        if (typeof result === "string") return result;
        if (Array.isArray(result) && result.every((part) => typeof part === "string")) {
          return result.join("");
        }
      } catch {
        // A broken selected message must not expose its key or block English.
      }
    }
    return LAST_RESORT_MESSAGE;
  }

  function rich<Value, Key extends MessageKey>(
    key: Key,
    values: TranslationValues,
    slots: Readonly<Record<string, RichTextSlot<Value>>>,
  ): Array<string | Value> {
    reportMissingMessage(key);
    const richValues: Record<
      string,
      PrimitiveType | Value | FormatXMLElementFn<Value>
    > = { ...values, ...slots };

    for (const candidate of candidates(key)) {
      try {
        const result = compiled(candidate).format<Value>(richValues);
        return Array.isArray(result) ? result : [result];
      } catch {
        // Unknown component slots or malformed messages safely use fallback.
      }
    }
    return [LAST_RESORT_MESSAGE];
  }

  return Object.freeze({
    language,
    formattingLocale,
    timeZone: options.timeZone,
    direction: options.direction ?? "ltr",
    translate,
    rich,
  });
}
