import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Papa from "papaparse";

import { resolveSupportedLanguage } from "@/i18n/language";
import { HttpError, type ApiErrorDescriptor, type ApiErrorParameters } from "@/lib/api-response";
import { DEFAULT_CURRENCY, isSupportedCurrency } from "@/lib/currencies";
import { assertValidTransferPair, type LedgerTransaction } from "@/lib/domain/balances";
import { currencyMinorToInput, currencyMinorUnitDigits } from "@/lib/domain/currency";
import { createTransaction, database, listTransactions, one } from "@/server/core";
import {
  collectAttachmentBackupFiles,
  installAttachmentBackupFiles,
  validateAttachmentBackupFiles,
  type AttachmentBackupFile,
} from "@/server/attachments";
import {
  convertMinorAtRate,
  crossRateScaled,
  deriveRateScaledFromAmounts,
  parseRateDecimalToScaled,
} from "@/server/fx";
import { getUserRegionalSettings } from "@/server/user-settings";

type CsvRecord = Record<string, string>;
export type ImportValidationError = Pick<ApiErrorDescriptor, "code" | "params">;

function importError(code: string, params?: ApiErrorParameters): ImportValidationError {
  return params ? { code, params } : { code };
}

function backupError(
  status: number,
  code: string,
  message: string,
  params?: ApiErrorParameters,
) {
  return new HttpError(status, {
    code: `BACKUP_${code}`,
    message,
    params,
  });
}

const MAX_BACKUP_ENVELOPE_BYTES = 100 * 1024 * 1024;
const MAX_IMPORT_CSV_BYTES = 20 * 1024 * 1024;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");

function guessColumn(headers: string[], patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = headers.find((header) => pattern.test(header.trim().toLowerCase()));
    if (match) return match;
  }
  return undefined;
}

export type ImportDateFormat = "auto" | "yyyy-MM-dd" | "dd.MM.yyyy" | "dd/MM/yyyy" | "MM/dd/yyyy";
export type ImportDecimalSeparator = "auto" | "," | ".";

function parseDate(value: string, format: ImportDateFormat = "auto") {
  const clean = value.trim();
  let key: string | null = null;
  if ((format === "auto" || format === "yyyy-MM-dd") && /^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    key = clean;
  } else {
    const delimiter = format === "dd.MM.yyyy" ? "\\." : "\\/";
    const pattern = format === "auto"
      ? /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/
      : new RegExp(`^(\\d{1,2})${delimiter}(\\d{1,2})${delimiter}(\\d{4})$`);
    const match = clean.match(pattern);
    if (!match || format === "yyyy-MM-dd") return null;
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (format === "auto" && first <= 12 && second <= 12) return null;
    const monthFirst = format === "MM/dd/yyyy" || (format === "auto" && second > 12);
    const day = monthFirst ? match[2] : match[1];
    const month = monthFirst ? match[1] : match[2];
    key = `${match[3]}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const date = new Date(`${key}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== key ? null : key;
}

function isAmbiguousNumericDate(value: string) {
  const match = value.trim().match(/^(\d{1,2})[./-](\d{1,2})[./-]\d{4}$/);
  return Boolean(match && Number(match[1]) <= 12 && Number(match[2]) <= 12);
}

function parseMinor(
  value: string,
  currency = DEFAULT_CURRENCY,
  decimalSeparator: ImportDecimalSeparator = "auto",
) {
  const clean = value.trim();
  if (!clean) return null;
  const fractionDigits = currencyMinorUnitDigits(currency);
  const negative = /^\(.*\)$/.test(clean) || clean.startsWith("-");
  const withoutCurrency = clean.replace(/[()\sA-Za-z]/g, "").replace(/^-/, "");
  const lastComma = withoutCurrency.lastIndexOf(",");
  const lastDot = withoutCurrency.lastIndexOf(".");
  if (decimalSeparator !== "auto") {
    const groupingSeparator = decimalSeparator === "," ? "." : ",";
    const decimalParts = withoutCurrency.split(decimalSeparator);
    if (decimalParts.length > 2 || (fractionDigits === 0 && decimalParts.length > 1)) return null;
    const [groupedWhole = "", decimals = ""] = decimalParts;
    if (!groupedWhole || (decimalParts.length > 1 && (!decimals || decimals.length > fractionDigits))) return null;
    if (decimals && !/^\d+$/.test(decimals)) return null;
    const groups = groupedWhole.split(groupingSeparator);
    if (groups.length > 1) {
      if (!/^\d{1,3}$/.test(groups[0] ?? "") || groups.slice(1).some((group) => !/^\d{3}$/.test(group))) {
        return null;
      }
    } else if (!/^\d+$/.test(groupedWhole)) {
      return null;
    }
    const wholeDigits = groups.join("");
    const scale = 10 ** fractionDigits;
    const minor = Number(wholeDigits) * scale + Number(decimals.padEnd(fractionDigits, "0") || "0");
    if (!Number.isSafeInteger(minor) || minor === 0) return null;
    return negative ? -minor : minor;
  }
  const separator = Math.max(lastComma, lastDot);
  let whole = withoutCurrency;
  let decimals = "";
  if (fractionDigits > 0 && separator >= 0 && withoutCurrency.length - separator <= fractionDigits + 1) {
    whole = withoutCurrency.slice(0, separator);
    decimals = withoutCurrency.slice(separator + 1);
  }
  whole = whole.replace(/[.,]/g, "");
  if (!/^\d+$/.test(whole) || !new RegExp(`^\\d{0,${fractionDigits}}$`).test(decimals)) return null;
  const scale = 10 ** fractionDigits;
  const minor = Number(whole) * scale + Number(decimals.padEnd(fractionDigits, "0") || "0");
  if (!Number.isSafeInteger(minor) || minor === 0) return null;
  return negative ? -minor : minor;
}

function rawFingerprint(accountId: string, date: string, amountMinor: number, description: string) {
  return createHash("sha256")
    .update(`${accountId}|${date}|${amountMinor}|${description.trim().toLowerCase()}`)
    .digest("hex");
}

export interface ImportPreviewInput {
  csv: string;
  mapping?: Record<string, string>;
  hasHeader?: boolean;
  accountId?: string;
  options?: {
    dateFormat?: ImportDateFormat;
    decimalSeparator?: ImportDecimalSeparator;
  };
}

export function previewImport(userId: string, input: ImportPreviewInput) {
  if (Buffer.byteLength(input.csv, "utf8") > MAX_IMPORT_CSV_BYTES) {
    throw new HttpError(413, {
      code: "IMPORT_CSV_TOO_LARGE",
      message: "CSV files must be smaller than 20 MB",
      params: { maxMegabytes: 20 },
    });
  }
  const account = input.accountId
    ? one<{ id: string; currency: string }>(
      "SELECT id, currency FROM accounts WHERE id = ? AND user_id = ? AND archived_at IS NULL",
      [input.accountId, userId],
    )
    : null;
  if (input.accountId && !account) {
    throw new HttpError(422, {
      code: "IMPORT_DESTINATION_ACCOUNT_REQUIRED",
      message: "Choose an active destination account",
    });
  }
  const accountCurrency = account?.currency ?? getUserRegionalSettings(userId).currency;
  const parsed = Papa.parse<CsvRecord>(input.csv, {
    header: input.hasHeader !== false,
    preview: 10_001,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });
  const rowOffset = input.hasHeader === false ? 1 : 2;
  const headers = parsed.meta.fields ?? Object.keys(parsed.data[0] ?? {});
  const mapping = {
    date: input.mapping?.date ?? guessColumn(headers, [/^date$/, /data/, /booking/, /occurred/]),
    amount: input.mapping?.amount ?? guessColumn(headers, [/^amount$/, /^posted[ _]amount$/, /suma/, /value/, /valoare/]),
    description: input.mapping?.description ?? guessColumn(headers, [/description/, /details/, /detalii/, /narrative/, /merchant/]),
    merchant: input.mapping?.merchant ?? guessColumn(headers, [/merchant/, /comerciant/, /payee/]),
    externalId: input.mapping?.externalId ?? guessColumn(headers, [
      /external[ _-]?id/,
      /transaction[ _-]?id/,
      /reference/,
      /^id$/,
    ]),
    originalAmount: input.mapping?.originalAmount ?? guessColumn(headers, [/original[ _]amount$/, /foreign[ _]amount$/, /merchant[ _]amount$/, /transaction[ _]amount$/]),
    originalCurrency: input.mapping?.originalCurrency ?? guessColumn(headers, [/original[ _]currency$/, /foreign[ _]currency$/, /transaction[ _]currency$/, /^currency$/]),
    exchangeRate: input.mapping?.exchangeRate ?? guessColumn(headers, [/^exchange[ _]rate$/, /^fx[ _]rate$/, /^conversion[ _]rate$/, /^curs$/]),
  };
  const errors: Array<{ row: number } & ImportValidationError> = parsed.errors.map((error) => ({
    row: (error.row ?? 0) + rowOffset,
    ...importError("IMPORT_CSV_PARSE_ERROR", { parserCode: error.code }),
  }));
  if (parsed.data.length > 10_000) {
    throw new HttpError(422, {
      code: "IMPORT_ROW_LIMIT_EXCEEDED",
      message: "One import is limited to 10,000 rows. Split the CSV into smaller files before importing",
      params: { maxRows: 10_000 },
    });
  }
  if (!mapping.date || !mapping.amount) {
    return {
      headers,
      mapping,
      rows: [],
      errors: [{ row: 1, ...importError("IMPORT_MAPPING_REQUIRED") }, ...errors],
      validCount: 0,
      invalidCount: parsed.data.length,
      duplicateCount: 0,
      overflowCount: 0,
    };
  }

  const rows = parsed.data.map((raw, index) => {
    const rawDate = raw[mapping.date!] ?? "";
    const dateFormat = input.options?.dateFormat ?? "auto";
    const decimalSeparator = input.options?.decimalSeparator ?? "auto";
    const date = parseDate(rawDate, dateFormat);
    const amountMinor = parseMinor(raw[mapping.amount!] ?? "", accountCurrency, decimalSeparator);
    const description = raw[mapping.description ?? ""]?.trim() ?? "";
    const merchant = raw[mapping.merchant ?? ""]?.trim() || description || null;
    const externalId = raw[mapping.externalId ?? ""]?.trim() || null;
    const originalCurrencyValue = raw[mapping.originalCurrency ?? ""]?.trim().toUpperCase() ?? "";
    const originalAmountValue = raw[mapping.originalAmount ?? ""]?.trim() ?? "";
    const exchangeRateValue = raw[mapping.exchangeRate ?? ""]?.trim() ?? "";
    const rowNumber = index + rowOffset;
    const validationErrors = errors
      .filter((error) => error.row === rowNumber)
      .map(({ code, params }) => importError(code, params));
    if (!date) {
      validationErrors.push(dateFormat === "auto" && isAmbiguousNumericDate(rawDate)
        ? importError("IMPORT_AMBIGUOUS_DATE")
        : importError("IMPORT_INVALID_DATE"));
    }
    if (amountMinor === null) validationErrors.push(importError("IMPORT_INVALID_AMOUNT"));
    const hasOriginalCurrency = Boolean(originalCurrencyValue);
    const hasOriginalAmount = Boolean(originalAmountValue);
    if (hasOriginalCurrency !== hasOriginalAmount) {
      validationErrors.push(importError("IMPORT_ORIGINAL_PAIR_REQUIRED"));
    }
    if (hasOriginalCurrency && !isSupportedCurrency(originalCurrencyValue)) {
      validationErrors.push(importError("IMPORT_UNSUPPORTED_ORIGINAL_CURRENCY", {
        currency: originalCurrencyValue,
      }));
    }
    const parsedOriginalAmount = hasOriginalAmount && isSupportedCurrency(originalCurrencyValue)
      ? parseMinor(originalAmountValue, originalCurrencyValue, decimalSeparator)
      : null;
    if (hasOriginalAmount && parsedOriginalAmount === null) {
      validationErrors.push(importError("IMPORT_INVALID_ORIGINAL_AMOUNT"));
    }

    let originalAmountMinor: number | null = null;
    let originalCurrency: string | null = null;
    let fxRateScaled: number | null = null;
    if (amountMinor !== null && parsedOriginalAmount !== null && isSupportedCurrency(originalCurrencyValue)) {
      if (Math.sign(amountMinor) !== Math.sign(parsedOriginalAmount)) {
        validationErrors.push(importError("IMPORT_AMOUNT_DIRECTION_MISMATCH"));
      } else if (originalCurrencyValue === accountCurrency) {
        if (Math.abs(amountMinor) !== Math.abs(parsedOriginalAmount)) {
          validationErrors.push(importError("IMPORT_SAME_CURRENCY_AMOUNT_MISMATCH"));
        }
      } else {
        originalAmountMinor = Math.abs(parsedOriginalAmount);
        originalCurrency = originalCurrencyValue;
        fxRateScaled = deriveRateScaledFromAmounts(
          originalAmountMinor,
          Math.abs(amountMinor),
          currencyMinorUnitDigits(originalCurrency),
          currencyMinorUnitDigits(accountCurrency),
        );
        const derivedPostedAmount = Math.abs(convertMinorAtRate(
          originalAmountMinor,
          fxRateScaled,
          currencyMinorUnitDigits(originalCurrency),
          currencyMinorUnitDigits(accountCurrency),
        ));
        if (derivedPostedAmount !== Math.abs(amountMinor)) {
          validationErrors.push(importError("IMPORT_FX_PRECISION_MISMATCH"));
        }
        if (exchangeRateValue) {
          try {
            const suppliedRate = parseRateDecimalToScaled(exchangeRateValue);
            const suppliedPostedAmount = Math.abs(convertMinorAtRate(
              originalAmountMinor,
              suppliedRate,
              currencyMinorUnitDigits(originalCurrency),
              currencyMinorUnitDigits(accountCurrency),
            ));
            if (Math.abs(suppliedPostedAmount - Math.abs(amountMinor)) > 1) {
              validationErrors.push(importError("IMPORT_EXCHANGE_RATE_MISMATCH"));
            }
          } catch {
            validationErrors.push(importError("IMPORT_INVALID_EXCHANGE_RATE"));
          }
        }
      }
    } else if (exchangeRateValue && !hasOriginalAmount) {
      validationErrors.push(importError("IMPORT_FX_ORIGINAL_REQUIRED"));
    }
    let duplicate = false;
    if (date && amountMinor !== null && input.accountId) {
      const externalDuplicate = externalId
        ? one("SELECT id FROM transactions WHERE user_id = ? AND account_id = ? AND external_id = ? AND voided_at IS NULL", [userId, input.accountId, externalId])
        : null;
      const comparable = one(
        `SELECT id FROM transactions WHERE user_id = ? AND account_id = ?
          AND substr(occurred_at, 1, 10) = ? AND amount_minor = ?
          AND LOWER(COALESCE(merchant_text, '')) = LOWER(?) AND voided_at IS NULL LIMIT 1`,
        [userId, input.accountId, date, amountMinor, merchant ?? ""],
      );
      duplicate = Boolean(externalDuplicate || comparable);
    }
    return {
      rowNumber,
      raw,
      date,
      amountMinor,
      currency: accountCurrency,
      originalAmountMinor,
      originalCurrency,
      fxRateScaled,
      fxRateSource: fxRateScaled ? "manual" as const : null,
      fxRateDate: fxRateScaled ? date : null,
      description,
      merchant,
      externalId,
      duplicate,
      valid: validationErrors.length === 0,
      validationErrors,
    };
  });
  return {
    headers,
    mapping,
    rows,
    errors,
    validCount: rows.filter((row) => row.valid && !row.duplicate).length,
    invalidCount: rows.filter((row) => !row.valid).length,
    duplicateCount: rows.filter((row) => row.duplicate).length,
    overflowCount: 0,
  };
}

interface CommitRow {
  date: string;
  amountMinor: number;
  description?: string;
  merchant?: string | null;
  categoryId?: string | null;
  externalId?: string | null;
  duplicate?: boolean;
  raw?: CsvRecord;
  originalAmountMinor?: number | null;
  originalCurrency?: string | null;
  fxRateScaled?: number | null;
  fxRateSource?: "manual" | null;
  fxRateDate?: string | null;
}

export function commitImport(
  userId: string,
  input: { accountId: string; rows: CommitRow[]; duplicateStrategy?: "skip" | "import"; fileName?: string; mapping?: Record<string, string> },
) {
  if (!input.rows.length || input.rows.length > 10_000) {
    throw new HttpError(422, {
      code: "IMPORT_ROW_COUNT_INVALID",
      message: "Choose between 1 and 10,000 rows to import",
      params: { minRows: 1, maxRows: 10_000 },
    });
  }
  const account = one<{ id: string; currency: string }>(
    "SELECT id, currency FROM accounts WHERE id = ? AND user_id = ? AND archived_at IS NULL",
    [input.accountId, userId],
  );
  if (!account) {
    throw new HttpError(422, {
      code: "IMPORT_DESTINATION_ACCOUNT_REQUIRED",
      message: "Choose an active destination account",
    });
  }
  const batchId = randomUUID();

  let imported = 0;
  let duplicates = 0;
  let invalid = 0;
  database().transaction(() => {
    database()
      .prepare(
        `INSERT INTO import_batches
          (id, user_id, account_id, file_name, status, column_mapping, total_rows)
         VALUES (?, ?, ?, ?, 'preview', ?, ?)`,
      )
      .run(
        batchId,
        userId,
        input.accountId,
        input.fileName?.trim().slice(0, 255) || "transactions.csv",
        JSON.stringify(input.mapping ?? {}),
        input.rows.length,
      );
    for (const [index, row] of input.rows.entries()) {
      const recordId = randomUUID();
      let status: "invalid" | "duplicate" | "imported" | "skipped" = "imported";
      let transactionId: string | null = null;
      let duplicateOfTransactionId: string | null = null;
      const validationErrors: ImportValidationError[] = [];
      if (parseDate(row.date) !== row.date || !Number.isSafeInteger(row.amountMinor) || row.amountMinor === 0) {
        status = "invalid";
        validationErrors.push(importError("IMPORT_INVALID_DATE_OR_AMOUNT"));
      }
      if (row.categoryId && !one(
        "SELECT id FROM categories WHERE id = ? AND user_id = ? AND archived_at IS NULL",
        [row.categoryId, userId],
      )) {
        status = "invalid";
        validationErrors.push(importError("IMPORT_CATEGORY_UNAVAILABLE"));
      }
      const hasOriginalAmount = row.originalAmountMinor !== undefined && row.originalAmountMinor !== null;
      const hasOriginalCurrency = Boolean(row.originalCurrency?.trim());
      const hasAnyFx = row.fxRateScaled != null || row.fxRateSource != null || row.fxRateDate != null;
      if (hasOriginalAmount !== hasOriginalCurrency) {
        status = "invalid";
        validationErrors.push(importError("IMPORT_ORIGINAL_PAIR_REQUIRED"));
      } else if (hasOriginalAmount && hasOriginalCurrency) {
        const originalAmountMinor = row.originalAmountMinor as number;
        const originalCurrency = row.originalCurrency!.trim().toUpperCase();
        if (!Number.isSafeInteger(originalAmountMinor) || originalAmountMinor <= 0 || !/^[A-Z]{3}$/.test(originalCurrency)) {
          status = "invalid";
          validationErrors.push(importError("IMPORT_INVALID_ORIGINAL_DATA"));
        } else if (originalCurrency === account.currency) {
          if (originalAmountMinor !== Math.abs(row.amountMinor) || hasAnyFx) {
            status = "invalid";
            validationErrors.push(importError("IMPORT_SAME_CURRENCY_FX_FORBIDDEN"));
          }
        } else if (
          row.fxRateSource !== "manual" ||
          !Number.isSafeInteger(row.fxRateScaled) ||
          (row.fxRateScaled ?? 0) <= 0 ||
          !row.fxRateDate ||
          parseDate(row.fxRateDate) !== row.fxRateDate
        ) {
          status = "invalid";
          validationErrors.push(importError("IMPORT_FOREIGN_FX_REQUIRED"));
        } else {
          const converted = convertMinorAtRate(
            originalAmountMinor,
            row.fxRateScaled as number,
            currencyMinorUnitDigits(originalCurrency),
            currencyMinorUnitDigits(account.currency),
          );
          if (converted !== Math.abs(row.amountMinor)) {
            status = "invalid";
            validationErrors.push(importError("IMPORT_FX_RECONCILIATION_FAILED"));
          }
        }
      } else if (hasAnyFx) {
        status = "invalid";
        validationErrors.push(importError("IMPORT_FX_ORIGINAL_REQUIRED"));
      }

      if (status === "invalid") {
        invalid += 1;
      } else {
        const existing = row.externalId
          ? one<{ id: string }>("SELECT id FROM transactions WHERE user_id = ? AND account_id = ? AND external_id = ? AND voided_at IS NULL", [userId, input.accountId, row.externalId])
          : one<{ id: string }>(
              `SELECT id FROM transactions WHERE user_id = ? AND account_id = ? AND substr(occurred_at, 1, 10) = ?
                AND amount_minor = ? AND LOWER(COALESCE(merchant_text, '')) = LOWER(?) AND voided_at IS NULL LIMIT 1`,
              [userId, input.accountId, row.date, row.amountMinor, row.merchant ?? row.description ?? ""],
            );
        duplicateOfTransactionId = existing?.id ?? null;
        if ((row.duplicate || existing) && input.duplicateStrategy !== "import") {
          status = "skipped";
          duplicates += 1;
        } else {
          const transaction = createTransaction(userId, {
            kind: row.amountMinor > 0 ? "income" : "expense",
            accountId: input.accountId,
            amountMinor: Math.abs(row.amountMinor),
            date: row.date,
            categoryId: row.categoryId,
            merchant: row.merchant ?? row.description,
            note: row.description,
            externalId: existing && row.externalId ? null : row.externalId,
            duplicateConfirmed: input.duplicateStrategy === "import",
            originalAmountMinor: row.originalAmountMinor,
            originalCurrency: row.originalCurrency,
            fxRateScaled: row.fxRateScaled,
            fxRateSource: row.fxRateSource,
            fxRateDate: row.fxRateDate,
          });
          transactionId = transaction.id;
          imported += 1;
        }
      }
      database()
        .prepare(
          `INSERT INTO import_records
            (id, batch_id, row_number, raw_data, status, duplicate_of_transaction_id, transaction_id, validation_errors)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          recordId,
          batchId,
          index + 2,
          JSON.stringify(row.raw ?? row),
          status,
          duplicateOfTransactionId,
          transactionId,
          validationErrors.length ? JSON.stringify(validationErrors) : null,
        );
    }
    database()
      .prepare(
        `UPDATE import_batches SET status = 'imported', imported_rows = ?, duplicate_rows = ?,
          invalid_rows = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(imported, duplicates, invalid, batchId);
  })();
  return { batchId, importedRows: imported, duplicateRows: duplicates, invalidRows: invalid };
}

function csvEscape(value: unknown) {
  const raw = value === null || value === undefined ? "" : String(value);
  // Spreadsheet applications can execute cells beginning with these characters as formulas.
  // Signed decimal strings are plain numbers and must retain their machine-readable form.
  const signedDecimal = /^[+-]?\d+(?:\.\d+)?$/.test(raw);
  const text = typeof value === "string" && !signedDecimal && /^[=+@\t\r-]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function scaledRateToDecimal(value: number | null) {
  if (!value || !Number.isSafeInteger(value) || value <= 0) return "";
  const whole = Math.floor(value / 100_000_000);
  const fraction = String(value % 100_000_000).padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sharedTableColumns(table: string) {
  const mainColumns = database()
    .prepare(`PRAGMA main.table_info(${quoteIdentifier(table)})`)
    .all() as Array<{ name: string }>;
  const restoreColumns = new Set(
    (database()
      .prepare(`PRAGMA restoredb.table_info(${quoteIdentifier(table)})`)
      .all() as Array<{ name: string }>).map((column) => column.name),
  );
  return mainColumns.map((column) => column.name).filter((name) => restoreColumns.has(name));
}

function restoreHasColumn(table: string, column: string) {
  return (database()
    .prepare(`PRAGMA restoredb.table_info(${quoteIdentifier(table)})`)
    .all() as Array<{ name: string }>).some((item) => item.name === column);
}

type RestoredTransaction = LedgerTransaction & {
  id: string;
  userId: string;
  accountCurrency: string;
  status: "pending" | "cleared" | "void";
  occurredAt: string;
};

type RestoredQuote = { rateDate: string; rateScaled: number };

function canonicalRestoredCurrency(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw backupError(422, "CURRENCY_MISSING", `The backup contains a missing ${label} currency`);
  }
  const normalized = value.trim().toUpperCase();
  if (value !== normalized || !isSupportedCurrency(normalized)) {
    throw backupError(422, "CURRENCY_INVALID", `The backup contains an unsupported or non-canonical ${label} currency`);
  }
  return normalized;
}

function validRestoredDate(value: unknown) {
  return typeof value === "string" && parseDate(value) === value;
}

function optionalTransactionColumn(column: string, alias: string) {
  return restoreHasColumn("transactions", column) ? `t.${quoteIdentifier(column)} AS ${alias}` : `NULL AS ${alias}`;
}

function restoredBnrQuote(requestedDate: string, fromCurrency: string, toCurrency: string): RestoredQuote | null {
  if (fromCurrency === toCurrency) return { rateDate: requestedDate, rateScaled: 100_000_000 };
  const hasObservations = database().prepare(
    "SELECT 1 FROM restoredb.sqlite_master WHERE type = 'table' AND name = 'fx_rate_observations'",
  ).get();
  if (!hasObservations) return null;

  const rateDate = fromCurrency === "RON" || toCurrency === "RON"
    ? database().prepare(
      `SELECT rate_date FROM restoredb.fx_rate_observations
        WHERE currency = ? AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1`,
    ).pluck().get(fromCurrency === "RON" ? toCurrency : fromCurrency, requestedDate) as string | undefined
    : database().prepare(
      `SELECT source.rate_date
         FROM restoredb.fx_rate_observations source
         JOIN restoredb.fx_rate_observations destination ON destination.rate_date = source.rate_date
        WHERE source.currency = ? AND destination.currency = ? AND source.rate_date <= ?
        ORDER BY source.rate_date DESC LIMIT 1`,
    ).pluck().get(fromCurrency, toCurrency, requestedDate) as string | undefined;
  if (!rateDate) return null;

  const observation = (currency: string) => currency === "RON"
    ? "RON" as const
    : database().prepare(
      `SELECT published_rate_scaled AS publishedRateScaled, multiplier
         FROM restoredb.fx_rate_observations WHERE rate_date = ? AND currency = ?`,
    ).get(rateDate, currency) as { publishedRateScaled: number; multiplier: number } | undefined;
  const source = observation(fromCurrency);
  const destination = observation(toCurrency);
  if (!source || !destination) return null;
  try {
    return { rateDate, rateScaled: crossRateScaled(source, destination) };
  } catch {
    return null;
  }
}

function validateRestoredFxProvenance(
  row: RestoredTransaction,
  originalCurrency: string,
  accountCurrency: string,
) {
  if (!Number.isSafeInteger(row.fxRateScaled) || (row.fxRateScaled ?? 0) <= 0) {
    throw backupError(422, "TRANSACTION_FX_RATE_INVALID", `Transaction ${row.id} has an invalid FX rate`);
  }
  if (row.fxRateSource !== "bnr" && row.fxRateSource !== "manual") {
    throw backupError(422, "TRANSACTION_FX_SOURCE_INVALID", `Transaction ${row.id} has an invalid FX source`);
  }
  if (!validRestoredDate(row.fxRateDate)) {
    throw backupError(422, "TRANSACTION_FX_DATE_INVALID", `Transaction ${row.id} has an invalid FX rate date`);
  }
  const hasReferenceRate = row.referenceFxRateScaled !== null && row.referenceFxRateScaled !== undefined;
  const hasReferenceDate = row.referenceFxRateDate !== null && row.referenceFxRateDate !== undefined;
  if (hasReferenceRate !== hasReferenceDate) {
    throw backupError(422, "TRANSACTION_REFERENCE_FX_INCOMPLETE", `Transaction ${row.id} has an incomplete reference FX quote`);
  }
  if (hasReferenceRate && (
    !Number.isSafeInteger(row.referenceFxRateScaled) || (row.referenceFxRateScaled ?? 0) <= 0
    || !validRestoredDate(row.referenceFxRateDate)
  )) {
    throw backupError(422, "TRANSACTION_REFERENCE_FX_INVALID", `Transaction ${row.id} has an invalid reference FX quote`);
  }
  if (row.fxRateSource === "bnr" && hasReferenceRate) {
    throw backupError(422, "TRANSACTION_REFERENCE_FX_DUPLICATE", `Transaction ${row.id} stores a duplicate reference quote for a BNR rate`);
  }

  if (row.fxRateSource === "bnr") {
    const quote = restoredBnrQuote(row.occurredAt, originalCurrency, accountCurrency);
    if (!quote || quote.rateScaled !== row.fxRateScaled || quote.rateDate !== row.fxRateDate) {
      throw backupError(422, "TRANSACTION_BNR_QUOTE_MISMATCH", `Transaction ${row.id} does not match its persisted official BNR quote`);
    }
  } else if (hasReferenceRate) {
    const quote = restoredBnrQuote(row.occurredAt, originalCurrency, accountCurrency);
    if (!quote || quote.rateScaled !== row.referenceFxRateScaled || quote.rateDate !== row.referenceFxRateDate) {
      throw backupError(422, "TRANSACTION_REFERENCE_QUOTE_MISMATCH", `Transaction ${row.id} does not match its persisted reference BNR quote`);
    }
  }
}

function validateRestoredNonTransferFx(row: RestoredTransaction) {
  const hasOriginalAmount = row.originalAmountMinor !== null && row.originalAmountMinor !== undefined;
  const hasOriginalCurrency = row.originalCurrency !== null && row.originalCurrency !== undefined;
  const hasAnyFx = row.fxRateScaled !== null && row.fxRateScaled !== undefined
    || row.fxRateSource !== null && row.fxRateSource !== undefined
    || row.fxRateDate !== null && row.fxRateDate !== undefined
    || row.referenceFxRateScaled !== null && row.referenceFxRateScaled !== undefined
    || row.referenceFxRateDate !== null && row.referenceFxRateDate !== undefined;
  if (hasOriginalAmount !== hasOriginalCurrency) {
    throw backupError(422, "TRANSACTION_ORIGINAL_PAIR_REQUIRED", `Transaction ${row.id} must store original amount and currency together`);
  }
  if (!hasOriginalAmount) {
    if (hasAnyFx) {
      throw backupError(422, "TRANSACTION_FX_WITHOUT_ORIGINAL", `Transaction ${row.id} has FX fields without original money`);
    }
    return;
  }
  if (!Number.isSafeInteger(row.originalAmountMinor) || (row.originalAmountMinor ?? 0) <= 0) {
    throw backupError(422, "TRANSACTION_ORIGINAL_AMOUNT_INVALID", `Transaction ${row.id} has an invalid original amount`);
  }
  const originalCurrency = canonicalRestoredCurrency(row.originalCurrency, "transaction original");
  if (originalCurrency === row.accountCurrency) {
    if (row.originalAmountMinor !== Math.abs(row.amountMinor) || hasAnyFx) {
      throw backupError(422, "TRANSACTION_SAME_CURRENCY_FX_INVALID", `Transaction ${row.id} has invalid same-currency original-money fields`);
    }
    return;
  }
  if (!hasAnyFx) {
    throw backupError(422, "TRANSACTION_FX_METADATA_MISSING", `Transaction ${row.id} is missing its foreign-currency FX metadata`);
  }
  validateRestoredFxProvenance(row, originalCurrency, row.accountCurrency);
  const converted = convertMinorAtRate(
    row.originalAmountMinor as number,
    row.fxRateScaled as number,
    currencyMinorUnitDigits(originalCurrency),
    currencyMinorUnitDigits(row.accountCurrency),
  );
  if (converted !== Math.abs(row.amountMinor)) {
    throw backupError(422, "TRANSACTION_FX_RECONCILIATION_FAILED", `Transaction ${row.id} original amount and FX rate do not reconcile to its account posting`);
  }
}

function validateRestoredMonetaryInvariants(userId: string) {
  const validateTableCurrencies = (table: string, ownerColumn = "user_id") => {
    const rows = database().prepare(
      `SELECT id, currency FROM restoredb.${quoteIdentifier(table)} WHERE ${quoteIdentifier(ownerColumn)} = ?`,
    ).all(userId) as Array<{ id: string; currency: unknown }>;
    for (const row of rows) canonicalRestoredCurrency(row.currency, table.replaceAll("_", " "));
  };
  validateTableCurrencies("accounts");
  validateTableCurrencies("planned_payments");
  if (restoreHasColumn("budgets", "currency")) validateTableCurrencies("budgets");
  if (restoreHasColumn("month_plans", "currency")) validateTableCurrencies("month_plans");

  const rows = database().prepare(
    `SELECT t.id, t.user_id AS userId, t.account_id AS accountId, t.kind, t.status,
            t.amount_minor AS amountMinor, t.currency, a.currency AS accountCurrency,
            t.occurred_at AS occurredAt, t.transfer_group_id AS transferGroupId,
            t.transfer_peer_id AS transferPeerId, t.voided_at AS voidedAt,
            ${optionalTransactionColumn("original_amount_minor", "originalAmountMinor")},
            ${optionalTransactionColumn("original_currency", "originalCurrency")},
            ${optionalTransactionColumn("fx_rate_scaled", "fxRateScaled")},
            ${optionalTransactionColumn("fx_rate_source", "fxRateSource")},
            ${optionalTransactionColumn("fx_rate_date", "fxRateDate")},
            ${optionalTransactionColumn("reference_fx_rate_scaled", "referenceFxRateScaled")},
            ${optionalTransactionColumn("reference_fx_rate_date", "referenceFxRateDate")}
       FROM restoredb.transactions t
       JOIN restoredb.accounts a ON a.id = t.account_id
      WHERE t.user_id = ? ORDER BY t.id`,
  ).all(userId) as RestoredTransaction[];
  const transferGroups = new Map<string, RestoredTransaction[]>();
  for (const row of rows) {
    row.currency = canonicalRestoredCurrency(row.currency, "transaction");
    row.accountCurrency = canonicalRestoredCurrency(row.accountCurrency, "account");
    if (row.currency !== row.accountCurrency) {
      throw backupError(422, "TRANSACTION_CURRENCY_MISMATCH", `Transaction ${row.id} currency does not match its account ledger`);
    }
    if (!Number.isSafeInteger(row.amountMinor) || row.amountMinor === 0) {
      throw backupError(422, "TRANSACTION_AMOUNT_INVALID", `Transaction ${row.id} has an invalid account amount`);
    }
    if (!validRestoredDate(row.occurredAt)) {
      throw backupError(422, "TRANSACTION_DATE_INVALID", `Transaction ${row.id} has an invalid transaction date`);
    }
    if (row.kind === "transfer") {
      if (!row.transferGroupId || !row.transferPeerId) {
        throw backupError(422, "TRANSFER_LINK_MISSING", `Transfer ${row.id} is missing its group or peer link`);
      }
      const group = transferGroups.get(row.transferGroupId) ?? [];
      group.push(row);
      transferGroups.set(row.transferGroupId, group);
    } else {
      if (row.transferGroupId || row.transferPeerId) {
        throw backupError(422, "TRANSACTION_TRANSFER_LINK_INVALID", `Non-transfer transaction ${row.id} carries transfer links`);
      }
      validateRestoredNonTransferFx(row);
    }
  }

  for (const [groupId, pair] of transferGroups) {
    try {
      assertValidTransferPair(pair);
    } catch {
      throw backupError(422, "TRANSFER_RECONCILIATION_FAILED", `Transfer group ${groupId} does not reconcile`);
    }
    const source = pair.find((row) => row.amountMinor < 0) as RestoredTransaction;
    const destination = pair.find((row) => row.amountMinor > 0) as RestoredTransaction;
    if (
      source.transferPeerId !== destination.id || destination.transferPeerId !== source.id
      || source.occurredAt !== destination.occurredAt || source.status !== destination.status
      || source.voidedAt !== destination.voidedAt
    ) {
      throw backupError(422, "TRANSFER_PEER_STATE_INVALID", `Transfer group ${groupId} has inconsistent peer state`);
    }
    if (source.currency !== destination.currency) {
      canonicalRestoredCurrency(destination.originalCurrency, "transfer original");
      validateRestoredFxProvenance(destination, source.currency as string, destination.currency as string);
    }
  }
}

export function exportData(userId: string, format: "csv" | "json") {
  const transactions = listTransactions(userId, { exportAll: true });
  if (format === "csv") {
    const headers = [
      "date", "type", "status", "account", "category", "merchant",
      "amount", "currency", "amount_minor", "original_amount", "original_currency", "original_amount_minor",
      "fx_rate", "fx_rate_scaled", "fx_rate_scale", "fx_rate_source", "fx_rate_date",
      "reference_fx_rate", "reference_fx_rate_scaled", "reference_fx_rate_date", "note", "tags",
      "account_id", "category_id", "transfer_group_id", "transfer_peer_id",
      "attachment_reference", "planned_occurrence_id", "external_id", "splits_json",
    ];
    const lines = [headers.join(",")];
    for (const item of transactions) {
      lines.push([
        item.date,
        item.type,
        item.status,
        item.account,
        item.category,
        item.merchant,
        currencyMinorToInput(item.amountMinor, item.currency),
        item.currency,
        item.amountMinor,
        item.originalAmountMinor && item.originalCurrency
          ? currencyMinorToInput(Math.sign(item.amountMinor) * item.originalAmountMinor, item.originalCurrency)
          : null,
        item.originalCurrency,
        item.originalAmountMinor,
        scaledRateToDecimal(item.fxRateScaled),
        item.fxRateScaled,
        item.fxRateScaled ? 100_000_000 : null,
        item.fxRateSource,
        item.fxRateDate,
        scaledRateToDecimal(item.referenceFxRateScaled),
        item.referenceFxRateScaled,
        item.referenceFxRateDate,
        item.note,
        item.tags,
        item.accountId,
        item.categoryId,
        item.transferGroupId,
        item.transferPeerId,
        item.attachmentRef,
        item.plannedOccurrenceId,
        item.externalId,
        item.splits.length ? JSON.stringify(item.splits) : null,
      ].map(csvEscape).join(","));
    }
    return { body: `\uFEFF${lines.join("\r\n")}`, contentType: "text/csv; charset=utf-8", extension: "csv" };
  }
  const tableQueries = [
    ["accounts", "SELECT * FROM accounts WHERE user_id = ?"],
    ["balance_snapshots", "SELECT s.* FROM balance_snapshots s JOIN accounts a ON a.id = s.account_id WHERE a.user_id = ?"],
    ["categories", "SELECT * FROM categories WHERE user_id = ?"],
    ["merchants", "SELECT * FROM merchants WHERE user_id = ?"],
    ["tags", "SELECT * FROM tags WHERE user_id = ?"],
    ["transactions", "SELECT * FROM transactions WHERE user_id = ?"],
    ["transaction_splits", "SELECT s.* FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id WHERE t.user_id = ?"],
    ["transaction_tags", "SELECT x.* FROM transaction_tags x JOIN transactions t ON t.id = x.transaction_id WHERE t.user_id = ?"],
    ["recurrence_rules", "SELECT * FROM recurrence_rules WHERE user_id = ?"],
    ["planned_payments", "SELECT * FROM planned_payments WHERE user_id = ?"],
    ["planned_payment_occurrences", "SELECT o.* FROM planned_payment_occurrences o JOIN planned_payments p ON p.id = o.planned_payment_id WHERE p.user_id = ?"],
    ["planned_payment_transactions", `SELECT x.* FROM planned_payment_transactions x
      JOIN planned_payment_occurrences o ON o.id = x.occurrence_id
      JOIN planned_payments p ON p.id = o.planned_payment_id WHERE p.user_id = ?`],
    ["budgets", "SELECT * FROM budgets WHERE user_id = ?"],
    ["month_plans", "SELECT * FROM month_plans WHERE user_id = ?"],
    ["month_plan_accounts", "SELECT x.* FROM month_plan_accounts x JOIN month_plans p ON p.id = x.month_plan_id WHERE p.user_id = ?"],
    ["month_plan_items", "SELECT x.* FROM month_plan_items x JOIN month_plans p ON p.id = x.month_plan_id WHERE p.user_id = ?"],
    ["plan_scenarios", `SELECT s.* FROM plan_scenarios s
      JOIN month_plans p ON p.id = s.month_plan_id WHERE p.user_id = ?`],
    ["scenario_adjustments", `SELECT a.* FROM scenario_adjustments a
      JOIN plan_scenarios s ON s.id = a.scenario_id
      JOIN month_plans p ON p.id = s.month_plan_id WHERE p.user_id = ?`],
    ["attachments", "SELECT * FROM attachments WHERE user_id = ?"],
    ["import_batches", "SELECT * FROM import_batches WHERE user_id = ?"],
    ["import_records", "SELECT r.* FROM import_records r JOIN import_batches b ON b.id = r.batch_id WHERE b.user_id = ?"],
    ["audit_logs", "SELECT * FROM audit_logs WHERE user_id = ?"],
    ["credit_card_profiles", "SELECT p.* FROM credit_card_profiles p JOIN accounts a ON a.id = p.account_id WHERE a.user_id = ?"],
    ["credit_card_statements", "SELECT s.* FROM credit_card_statements s JOIN accounts a ON a.id = s.account_id WHERE a.user_id = ?"],
    ["credit_card_payments", "SELECT * FROM credit_card_payments WHERE user_id = ?"],
    ["loan_profiles", "SELECT p.* FROM loan_profiles p JOIN accounts a ON a.id = p.account_id WHERE a.user_id = ?"],
    ["loan_rate_periods", "SELECT p.* FROM loan_rate_periods p JOIN accounts a ON a.id = p.loan_account_id WHERE a.user_id = ?"],
    ["loan_schedule_entries", "SELECT e.* FROM loan_schedule_entries e JOIN accounts a ON a.id = e.loan_account_id WHERE a.user_id = ?"],
    ["loan_payments", "SELECT * FROM loan_payments WHERE user_id = ?"],
  ] as const;
  const data: Record<string, unknown[]> = {};
  for (const [table, sql] of tableQueries) {
    data[table] = database().prepare(sql).all(userId) as unknown[];
  }
  return {
    body: JSON.stringify({
      format: "ledgerlab-export-v2",
      exportedAt: new Date().toISOString(),
      fxRateScale: 100_000_000,
      rowCounts: Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, rows.length])),
      profile: one(
        `SELECT default_currency AS defaultCurrency, locale, time_zone AS timeZone,
                ui_language AS uiLanguage
           FROM users WHERE id = ?`,
        [userId],
      ),
      data,
    }, null, 2),
    contentType: "application/json; charset=utf-8",
    extension: "json",
  };
}

export function createBackup(userId: string) {
  const user = one<{ email: string }>("SELECT email FROM users WHERE id = ?", [userId]);
  if (!user) throw backupError(404, "USER_NOT_FOUND", "User not found");
  const userCount = one<{ count: number }>("SELECT COUNT(*) AS count FROM users")?.count ?? 0;
  if (userCount !== 1) {
    throw backupError(403, "SOLE_OWNER_REQUIRED", "Full database backups are available only when this local LedgerLab database has one owner. Use JSON/CSV export for a user-scoped copy");
  }
  const buffer = database().serialize();
  const backup = {
    format: "ledgerlab-sqlite-v1",
    createdAt: new Date().toISOString(),
    owner: user.email,
    checksum: createHash("sha256").update(buffer).digest("hex"),
    database: buffer.toString("base64"),
    attachments: collectAttachmentBackupFiles(userId),
  };
  if (Buffer.byteLength(JSON.stringify(backup), "utf8") > MAX_BACKUP_ENVELOPE_BYTES) {
    throw backupError(413, "TOO_LARGE", "The complete backup exceeds 100 MB. Remove large receipt files before creating this backup", {
      maxMegabytes: 100,
    });
  }
  return backup;
}

export function restoreBackup(userId: string, input: { backup: string; confirmation: string }) {
  if (input.confirmation !== "RESTORE") {
    throw backupError(422, "RESTORE_CONFIRMATION_REQUIRED", "Type RESTORE to confirm replacement");
  }
  if (Buffer.byteLength(input.backup, "utf8") > MAX_BACKUP_ENVELOPE_BYTES) {
    throw backupError(413, "RESTORE_FILE_TOO_LARGE", "Backup files must be smaller than 100 MB", {
      maxMegabytes: 100,
    });
  }
  const userCount = one<{ count: number }>("SELECT COUNT(*) AS count FROM users")?.count ?? 0;
  if (userCount !== 1 || !one("SELECT id FROM users WHERE id = ?", [userId])) {
    throw backupError(403, "RESTORE_SOLE_OWNER_REQUIRED", "Full database restore is available only to the sole owner of this local database");
  }
  let payload: {
    format?: string;
    database?: string;
    checksum?: string;
    owner?: string;
    attachments?: AttachmentBackupFile[];
  };
  try {
    payload = JSON.parse(Buffer.from(input.backup, "base64").toString("utf8")) as typeof payload;
  } catch {
    try {
      payload = JSON.parse(input.backup) as typeof payload;
    } catch {
      throw backupError(422, "INVALID", "This is not a valid LedgerLab backup");
    }
  }
  if (payload.format !== "ledgerlab-sqlite-v1" || !payload.database) {
    throw backupError(422, "FORMAT_UNSUPPORTED", "Unsupported backup format");
  }
  if (!payload.checksum || !/^[0-9a-f]{64}$/i.test(payload.checksum)) {
    throw backupError(422, "CHECKSUM_MISSING", "The backup is missing a valid SHA-256 checksum");
  }
  const buffer = Buffer.from(payload.database, "base64");
  if (buffer.length < SQLITE_HEADER.length || !buffer.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    throw backupError(422, "DATABASE_MISSING", "The backup does not contain a SQLite database");
  }
  if (createHash("sha256").update(buffer).digest("hex") !== payload.checksum.toLowerCase()) {
    throw backupError(422, "CHECKSUM_INVALID", "Backup checksum validation failed");
  }
  const currentUser = one<{ email: string }>("SELECT email FROM users WHERE id = ?", [userId]);
  const restoreDirectory = path.join(process.cwd(), "data", "restore-staging");
  mkdirSync(restoreDirectory, { recursive: true });
  const restoreFile = path.join(restoreDirectory, `${randomUUID()}.db`);
  writeFileSync(restoreFile, buffer, { flag: "wx" });

  const requiredTables = [
    "users",
    "sessions",
    "accounts",
    "balance_snapshots",
    "categories",
    "merchants",
    "tags",
    "transactions",
    "transaction_splits",
    "transaction_tags",
    "recurrence_rules",
    "planned_payments",
    "planned_payment_occurrences",
    "planned_payment_transactions",
    "budgets",
    "month_plans",
    "month_plan_accounts",
    "month_plan_items",
    "plan_scenarios",
    "scenario_adjustments",
    "attachments",
    "import_batches",
    "import_records",
    "audit_logs",
  ];
  const liabilityTables = [
    "credit_card_profiles",
    "credit_card_statements",
    "credit_card_payments",
    "loan_profiles",
    "loan_rate_periods",
    "loan_schedule_entries",
    "loan_payments",
  ];
  const fxTables = ["fx_rate_observations", "fx_sync_metadata"];
  const tables = [...requiredTables, ...liabilityTables, ...fxTables];
  const deletionOrder = [...tables].reverse();
  const connection = database();
  try {
    connection.prepare("ATTACH DATABASE ? AS restoredb").run(restoreFile);
    const integrity = connection.prepare("PRAGMA restoredb.integrity_check").pluck().get();
    if (integrity !== "ok") {
      throw backupError(422, "DATABASE_INTEGRITY_FAILED", "The backup database did not pass its integrity check");
    }
    const available = new Set(
      (connection.prepare("SELECT name FROM restoredb.sqlite_master WHERE type = 'table'").pluck().all() as string[]),
    );
    if (requiredTables.some((table) => !available.has(table))) {
      throw backupError(422, "TABLES_MISSING", "The backup is missing required LedgerLab tables");
    }
    const sourceIntegrityViolations = connection.prepare("PRAGMA restoredb.foreign_key_check").all() as unknown[];
    if (sourceIntegrityViolations.length) {
      throw backupError(422, "RELATIONSHIPS_INVALID", "The backup contains broken relationships");
    }
    const sourceOwnerCount = connection.prepare("SELECT COUNT(*) AS count FROM restoredb.users").get() as { count: number };
    if (sourceOwnerCount.count !== 1) {
      throw backupError(422, "OWNER_COUNT_INVALID", "A full restore must contain exactly one local owner");
    }
    const expectedEmail = currentUser?.email.trim().toLowerCase();
    const sourceHasUiLanguage = restoreHasColumn("users", "ui_language");
    const sourceOwner = expectedEmail
      ? connection.prepare(
          `SELECT id, default_currency AS defaultCurrency,
                  ${sourceHasUiLanguage ? "ui_language" : "NULL"} AS uiLanguage
             FROM restoredb.users WHERE normalized_email = ?`,
        ).get(expectedEmail) as { id: string; defaultCurrency: string; uiLanguage: unknown } | undefined
      : null;
    if (!sourceOwner) {
      throw backupError(409, "OWNER_MISMATCH", "This backup belongs to a different local owner. The current database was not changed");
    }
    const reportingCurrency = canonicalRestoredCurrency(sourceOwner.defaultCurrency, "reporting");
    const restoredUiLanguage = resolveSupportedLanguage(sourceOwner.uiLanguage);
    const originalCurrencyCheck = restoreHasColumn("transactions", "original_currency")
      ? `OR (t.original_currency IS NOT NULL AND (
              length(trim(t.original_currency)) <> 3 OR upper(trim(t.original_currency)) GLOB '*[^A-Z]*'
            ))`
      : "";
    const currencyViolations = connection.prepare(
      `SELECT COUNT(*) AS count FROM (
         SELECT a.id
           FROM restoredb.accounts a
          WHERE a.user_id = ? AND (
            length(trim(a.currency)) <> 3 OR upper(trim(a.currency)) GLOB '*[^A-Z]*'
          )
         UNION ALL
         SELECT p.id
           FROM restoredb.planned_payments p
          WHERE p.user_id = ? AND (
            length(trim(p.currency)) <> 3 OR upper(trim(p.currency)) GLOB '*[^A-Z]*'
          )
         UNION ALL
         SELECT t.id
           FROM restoredb.transactions t
           JOIN restoredb.accounts a ON a.id = t.account_id
          WHERE t.user_id = ? AND (
            upper(trim(t.currency)) <> upper(trim(a.currency))
            ${originalCurrencyCheck}
          )
       )`,
    ).get(
      sourceOwner.id,
      sourceOwner.id,
      sourceOwner.id,
    ) as { count: number };
    if (currencyViolations.count) {
      throw backupError(
        422,
        "CURRENCY_LEDGER_MISMATCH",
        "The backup contains an invalid currency or a transaction whose currency does not match its account ledger",
      );
    }
    for (const table of ["budgets", "month_plans"] as const) {
      if (!restoreHasColumn(table, "currency")) continue;
      const invalid = connection.prepare(
        `SELECT COUNT(*) AS count FROM restoredb.${quoteIdentifier(table)}
          WHERE length(trim(currency)) <> 3 OR upper(trim(currency)) GLOB '*[^A-Z]*'`,
      ).get() as { count: number };
      if (invalid.count) {
        throw backupError(
          422,
          table === "budgets" ? "BUDGET_CURRENCY_INVALID" : "MONTH_PLAN_CURRENCY_INVALID",
          `The backup contains an invalid ${table === "budgets" ? "budget" : "monthly-plan"} currency`,
        );
      }
    }
    validateRestoredMonetaryInvariants(sourceOwner.id);

    const expectedAttachmentFiles = connection.prepare(
      `SELECT DISTINCT storage_path AS storagePath, size_bytes AS sizeBytes, sha256
         FROM restoredb.attachments
        WHERE user_id = ? AND storage_path IS NOT NULL
        ORDER BY storage_path`,
    ).all(sourceOwner.id) as Array<{ storagePath: string; sizeBytes: number; sha256: string }>;
    const attachmentFiles = validateAttachmentBackupFiles(payload.attachments ?? [], expectedAttachmentFiles);
    installAttachmentBackupFiles(attachmentFiles);

    connection.pragma("foreign_keys = OFF");
    connection.transaction(() => {
      for (const table of deletionOrder) connection.exec(`DELETE FROM main.${table}`);
      for (const table of tables) {
        if (!available.has(table)) continue;
        const columns = sharedTableColumns(table).filter(
          (column) => table !== "users" || column !== "ui_language",
        );
        if (!columns.length) continue;
        const columnList = columns.map(quoteIdentifier).join(", ");
        connection.exec(
          `INSERT INTO main.${quoteIdentifier(table)} (${columnList}) ` +
          `SELECT ${columnList} FROM restoredb.${quoteIdentifier(table)}`,
        );
      }
      if (!restoreHasColumn("budgets", "currency")) {
        connection.prepare("UPDATE main.budgets SET currency = ? WHERE user_id = ?").run(reportingCurrency, sourceOwner.id);
      }
      if (!restoreHasColumn("month_plans", "currency")) {
        connection.prepare("UPDATE main.month_plans SET currency = ? WHERE user_id = ?").run(reportingCurrency, sourceOwner.id);
      }
      connection.prepare("UPDATE main.users SET ui_language = ? WHERE id = ?")
        .run(restoredUiLanguage, sourceOwner.id);
      const violations = connection.pragma("foreign_key_check") as unknown[];
      if (violations.length) {
        throw backupError(422, "RESTORED_RELATIONSHIPS_INVALID", "The restored backup contains broken relationships");
      }
    }).immediate();
    connection.pragma("foreign_keys = ON");
  } finally {
    try {
      connection.exec("DETACH DATABASE restoredb");
    } catch {
      // Nothing is attached when validation failed before ATTACH completed.
    }
    connection.pragma("foreign_keys = ON");
    try {
      rmSync(restoreFile, { force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // A locked staging file remains isolated from the active database and is ignored.
    }
  }
  const restoredOwner = currentUser
    ? one<{ id: string }>("SELECT id FROM users WHERE normalized_email = ?", [currentUser.email.trim().toLowerCase()])
    : null;
  if (!restoredOwner) {
    throw backupError(409, "ACCOUNT_MISSING_AFTER_RESTORE", "Backup restored, but your previous account is not present. Sign in using credentials stored in the backup.");
  }
  return { success: true, code: "BACKUP_RESTORE_SUCCEEDED" as const };
}

export function importFingerprintPreview(accountId: string, date: string, amountMinor: number, description: string) {
  return rawFingerprint(accountId, date, amountMinor, description);
}
