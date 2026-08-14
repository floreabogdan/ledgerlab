# Internationalization

LedgerLab discovers complete language packs from `locales/<tag>/`. Product-owned interface copy lives in YAML; application code refers to typed semantic keys and never treats an English sentence as an identifier.

## Interface language and regional formatting

Interface language controls headings, actions, help, accessibility labels, validation, and errors. It is independent from:

- formatting locale, which controls number and date presentation;
- time zone, which controls workspace calendar boundaries; and
- workspace currency, which controls reporting and newly created records.

Changing interface language never rewrites accounts, categories, transactions, notes, merchant names, or other stored user data. For signed-in users the saved profile preference wins. Anonymous pages use the language cookie, then `Accept-Language`, then English.

## Add a language

Adding a language is a YAML-only contribution:

1. Copy `locales/en/` to `locales/<tag>/`, where `<tag>` is a canonical BCP 47 tag such as `ro` or `pt-BR`.
2. Update `manifest.yaml` and translate the values in `common.yaml`, `auth.yaml`, `entities.yaml`, `finance.yaml`, `planning.yaml`, `settings.yaml`, and `errors.yaml`.
3. Run `npm run i18n:check`.
4. Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
5. Submit the complete language pack in a pull request and describe who reviewed its terminology.

Keep every English key and every named ICU argument unchanged. Use the language's real cardinal plural categories rather than copying English `one`/`other` branches blindly. Catalog values must be UTF-8, must not contain raw HTML, and should use ICU named interpolation instead of sentence concatenation.

The validation command rejects missing or extra files, invalid YAML, non-canonical manifests, key or placeholder drift, invalid ICU syntax, unsafe markup, and incomplete packs. Generated TypeScript under `src/i18n/generated/` is disposable build output and is not committed.

Default category labels are language-pack values used only when a new workspace is created. Switching an existing workspace does not rename its categories.

## Hard-coded copy guard

`npm run i18n:copy` scans application TSX for product-owned text that bypasses the catalogs, including visible JSX, accessibility labels, presentation props, client errors, and state messages. `npm run lint` runs this check automatically, and CI also exposes it as a separate gate.

An intentionally untranslated visible token may be added to `scripts/i18n-copy-allowlist.ts` with its source file, exact text, and a specific nonblank reason. Keep exemptions narrow. The guard rejects blank reasons, duplicate exemptions, and stale entries that no longer match source.

## Message-key conventions

Keys describe purpose rather than repeat English copy. Prefer `finance.transactions.form.amount` to a sentence-shaped key. Preserve as data instead of translating:

- user-authored names, notes, descriptions, and imported text;
- ISO currency and language codes;
- URLs, route names, database identifiers, and protocol tokens;
- product and external organization names where the proper name does not change.

Dynamic sentences use named values and ICU plurals. Accessibility names, empty states, loading states, confirmations, and visually hidden text follow the same rules as visible copy.

## Structured API errors

API failures contain descriptors, not presentation text:

```json
{
  "error": {
    "code": "IMPORT_ROW_LIMIT_EXCEEDED",
    "params": { "maxRows": 10000 }
  }
}
```

Validation retains field paths:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "issues": [
      {
        "code": "VALIDATION_TOO_SMALL",
        "path": ["rows", 0, "amountMinor"],
        "params": { "minimum": 1 }
      }
    ]
  }
}
```

Server code should throw an explicit `HttpError` with:

- an uppercase stable `code` that describes the condition;
- an internal diagnostic `message` that is never returned by the API;
- optional named `params` containing only safe string, number, boolean, or null values; and
- optional internal `details`, which remain server-side.

Add the localized message under `errors.codes` using the lower-camel form of the code. For example, `IMPORT_ROW_LIMIT_EXCEEDED` maps to `errors.codes.importRowLimitExceeded`. Clients parse descriptors with `parseApiError` and render them with `translateApiError`. They must not display raw codes, diagnostics, response bodies, or compare English sentences. An unknown or malformed failure always becomes the localized generic error.

Server-derived non-error presentation follows the same boundary: return semantic enums, message codes, and safe parameters, then render them in the selected language on the client.

## Review checklist

- Test the feature with English and a non-English catalog.
- Check visible copy, dialogs, placeholders, charts, tooltips, screen-reader text, and ARIA names.
- Verify named variables and singular/plural cases.
- Confirm that changing language leaves regional settings and stored finance data unchanged.
- Confirm that API responses contain no product-owned sentences.
- Run the catalog check, standard test suite, browser workflows, and production build.
