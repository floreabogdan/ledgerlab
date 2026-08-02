"use client";

import Link from "next/link";
import { ArrowRight, Check, FileSpreadsheet, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import Papa from "papaparse";
import { useRef, useState } from "react";
import { useTranslator } from "@/i18n/client";
import { parseApiError, translateApiError } from "@/lib/api-error";
import type { Translator } from "@/i18n/runtime";
import {
  Button,
  Field,
  FormMessage,
  formatDate,
  formatMoney,
  numberFrom,
  Page,
  Pill,
  readList,
  readRecord,
  requestJson,
  ResponsiveTable,
  Section,
  Select,
  stringFrom,
  useJson,
  ViewHeader,
  workspaceLocale,
} from "../_components/feature-kit";
import { DEFAULT_CURRENCY } from "@/lib/currencies";
import kit from "../_components/feature.module.css";
import ui from "../_components/pages.module.css";

type Row = Record<string, unknown>;
type ImportStep = 1 | 2 | 3 | 4;
type Mapping = Record<string, string>;

function translateImportError(translator: Translator, value: unknown) {
  return translateApiError(translator, parseApiError(value));
}

const targetFields = [
  ["", "finance.import.targetFields.doNotImport"],
  ["date", "finance.import.targetFields.date"],
  ["amount", "finance.import.targetFields.amount"],
  ["originalAmount", "finance.import.targetFields.originalAmount"],
  ["originalCurrency", "finance.import.targetFields.originalCurrency"],
  ["exchangeRate", "finance.import.targetFields.exchangeRate"],
  ["kind", "finance.import.targetFields.kind"],
  ["merchant", "finance.import.targetFields.merchant"],
  ["account", "finance.import.targetFields.account"],
  ["category", "finance.import.targetFields.category"],
  ["notes", "finance.import.targetFields.notes"],
  ["tags", "finance.import.targetFields.tags"],
  ["status", "finance.import.targetFields.status"],
] as const;

function formatFxRate(rateScaled: unknown) {
  const value = numberFrom(rateScaled);
  if (!value) return "";
  return new Intl.NumberFormat(workspaceLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(value / 100_000_000);
}

function autoMap(headers: string[]) {
  const mapping: Mapping = {};
  const patterns: Array<[string, RegExp]> = [
    ["date", /^(date|data|transaction date|booking date)$/i],
    ["amount", /^(amount|sum|suma|value|debit|valoare)$/i],
    ["originalAmount", /^(original[ _]amount|foreign[ _]amount|merchant[ _]amount|transaction[ _]amount)$/i],
    ["originalCurrency", /^(original[ _]currency|foreign[ _]currency|transaction[ _]currency|currency)$/i],
    ["exchangeRate", /^(exchange[ _]rate|fx[ _]rate|conversion[ _]rate|curs)$/i],
    ["kind", /^(type|kind|tip|direction)$/i],
    ["merchant", /^(merchant|description|descriere|payee|details)$/i],
    ["account", /^(account|cont|account name)$/i],
    ["category", /^(category|categorie)$/i],
    ["notes", /^(notes|note|memo|comentariu)$/i],
    ["tags", /^(tags|etichete)$/i],
    ["status", /^(status|state)$/i],
  ];

  headers.forEach((header) => {
    mapping[header] = patterns.find(([, pattern]) => pattern.test(header.trim()))?.[0] ?? "";
  });

  return mapping;
}

export default function ImportTransactionsPage() {
  const translator = useTranslator();
  const t = translator.translate;
  const { data: accountRaw } = useJson<Record<string, unknown>>("/api/accounts", {});
  const accounts = readList<Row>(accountRaw, "accounts").filter((item) => !Boolean(readRecord(item).archivedAt ?? readRecord(item).isArchived));
  const importRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<ImportStep>(1);
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [sample, setSample] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [defaultAccountId, setDefaultAccountId] = useState("");
  const [dateFormat, setDateFormat] = useState("auto");
  const [decimalSeparator, setDecimalSeparator] = useState("auto");
  const [duplicateHandling, setDuplicateHandling] = useState("skip");
  const [preview, setPreview] = useState<Record<string, unknown>>({});
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function chooseCsv(file?: File) {
    if (!file) return;
    setError(null);
    setSuccess(null);

    if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
      setError(t("finance.import.errors.chooseCsv"));
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError(t("finance.import.errors.fileTooLarge"));
      return;
    }

    const text = await file.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, preview: 6, skipEmptyLines: true });
    const foundHeaders = parsed.meta.fields ?? [];
    if (!foundHeaders.length) {
      setError(t("finance.import.errors.noHeader"));
      return;
    }

    setCsv(text);
    setFileName(file.name);
    setHeaders(foundHeaders);
    setSample(parsed.data);
    setMapping(autoMap(foundHeaders));
    setStep(2);
  }

  async function createPreview() {
    setWorking(true);
    setError(null);
    setSuccess(null);
    try {
      if (!Object.values(mapping).includes("date")) throw new Error(t("finance.import.errors.mapDate"));
      if (!Object.values(mapping).includes("amount")) throw new Error(t("finance.import.errors.mapAmount"));
      if (!defaultAccountId) throw new Error(t("finance.import.errors.chooseDestination"));
      const hasOriginalAmount = Object.values(mapping).includes("originalAmount");
      const hasOriginalCurrency = Object.values(mapping).includes("originalCurrency");
      const hasExchangeRate = Object.values(mapping).includes("exchangeRate");
      if (hasOriginalAmount !== hasOriginalCurrency) throw new Error(t("finance.import.errors.originalPair"));
      if (hasExchangeRate && !hasOriginalAmount) throw new Error(t("finance.import.errors.rateNeedsOriginal"));

      const result = await requestJson<Record<string, unknown>>("/api/import/preview", {
        method: "POST",
        body: JSON.stringify({
          csv,
          fileName,
          mapping,
          defaultAccountId,
          options: { dateFormat, decimalSeparator },
        }),
      });
      setPreview(readRecord(readRecord(result).data ?? result));
      setStep(3);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("finance.import.errors.validateFallback"));
    } finally {
      setWorking(false);
    }
  }

  async function commitImport() {
    setWorking(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await requestJson<Record<string, unknown>>("/api/import/commit", {
        method: "POST",
        body: JSON.stringify({
          csv,
          fileName,
          mapping,
          defaultAccountId,
          duplicateHandling,
          options: { dateFormat, decimalSeparator },
          previewToken: preview.previewToken ?? null,
        }),
      });
      const resultRecord = readRecord(readRecord(result).data ?? result);
      setPreview(resultRecord);
      setSuccess(t("finance.import.result.summary", {
        imported: numberFrom(resultRecord.importedCount ?? resultRecord.imported),
        skipped: numberFrom(resultRecord.skippedCount ?? resultRecord.skipped),
      }));
      setStep(4);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("finance.import.errors.importFallback"));
    } finally {
      setWorking(false);
    }
  }

  function resetImport() {
    setStep(1);
    setCsv("");
    setFileName("");
    setHeaders([]);
    setSample([]);
    setMapping({});
    setPreview({});
    setError(null);
    setSuccess(null);
    setDefaultAccountId("");
    if (importRef.current) importRef.current.value = "";
  }

  const previewRows = readList<Row>(preview, "rows", "previewRows");
  const previewErrors = readList<Row>(preview, "errors", "validationErrors");
  const previewDuplicates = readList<Row>(preview, "duplicates");
  const invalidPreviewRows = previewRows.filter((item) => readRecord(item).valid === false);
  const summary = readRecord(preview.summary);
  const defaultAccount = readRecord(accounts.find((item) => String(readRecord(item).id) === defaultAccountId));
  const defaultAccountCurrency = stringFrom(defaultAccount.currency, DEFAULT_CURRENCY);

  return (
    <Page>
      <ViewHeader
        eyebrow={t("finance.import.eyebrow")}
        title={t("finance.import.title")}
        description={t("finance.import.description")}
        actions={<Link href="/import-export" className={`${kit.button} ${kit.button_secondary}`}>{t("finance.import.actions.dataAndBackups")}</Link>}
      />
      <FormMessage error={error} success={success} />

      <Section title={t("finance.import.section.title")} description={t("finance.import.section.description")}>
        <div className={ui.contentInset}>
          <div className={ui.stepper} aria-label={t("finance.import.steps.aria", { step, total: 4 })}>
            {[
              t("finance.import.steps.chooseFile"),
              t("finance.import.steps.mapColumns"),
              t("finance.import.steps.review"),
              t("finance.import.steps.complete"),
            ].map((label, index) => (
              <div className={`${ui.step} ${step >= index + 1 ? ui.stepActive : ""}`} key={label}>
                <span>{step > index + 1 ? <Check size={14} /> : index + 1}</span>
                {label}
              </div>
            ))}
          </div>

          {step === 1 ? (
            <label
              className={ui.dropZone}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void chooseCsv(event.dataTransfer.files[0]);
              }}
            >
              <FileSpreadsheet size={32} />
              <strong>{t("finance.import.file.dropTitle")}</strong>
              <small>{t("finance.import.file.dropDescription")}</small>
              <Button type="button" variant="secondary" icon={<Upload size={15} />} onClick={() => importRef.current?.click()}>{t("finance.import.actions.chooseCsv")}</Button>
              <input ref={importRef} className={ui.hiddenFile} type="file" accept=".csv,text/csv" onChange={(event) => void chooseCsv(event.target.files?.[0])} />
            </label>
          ) : null}

          {step === 2 ? (
            <div>
              <div className={ui.toolbar}>
                <div>
                  <strong>{fileName}</strong>
                  <div className={`${ui.small} ${ui.muted}`}>{t("finance.import.file.columnsDetected", { count: headers.length })}</div>
                </div>
                <Button variant="ghost" onClick={resetImport}>{t("finance.import.actions.chooseAnotherFile")}</Button>
              </div>
              <div className={ui.twoColumn}>
                <Section title={t("finance.import.mapping.title")} description={t("finance.import.mapping.description")}>
                  <div className={`${ui.contentInsetCompact} ${ui.verticalStackCompact}`}>
                    {headers.map((header) => (
                      <div className={ui.mappingGrid} key={header}>
                        <strong>{header}<small className={ui.tableSecondary}>{sample[0]?.[header] || t("finance.import.mapping.emptySample")}</small></strong>
                        <span><ArrowRight size={16} /></span>
                        <Select
                          aria-label={t("finance.import.mapping.aria", { header })}
                          value={mapping[header] ?? ""}
                          onValueChange={(value) => setMapping((current) => {
                            const next = { ...current };
                            Object.keys(next).forEach((key) => {
                              if (next[key] === value && key !== header && value) next[key] = "";
                            });
                            next[header] = value;
                            return next;
                          })}
                        >
                          {targetFields.map(([value, labelKey]) => <option value={value} key={value}>{t(labelKey)}</option>)}
                        </Select>
                      </div>
                    ))}
                  </div>
                </Section>
                <Section title={t("finance.import.defaults.title")} description={t("finance.import.defaults.description")}>
                  <div className={`${ui.contentInsetCompact} ${ui.verticalStack}`}>
                    <Field label={t("finance.import.defaults.account")}>
                      <Select value={defaultAccountId} onValueChange={(value) => setDefaultAccountId(value)}>
                        <option value="">{t("finance.import.defaults.chooseAccount")}</option>
                        {accounts.map((item, index) => {
                          const account = readRecord(item);
                          return <option value={String(account.id)} key={stringFrom(account.id, String(index))}>{stringFrom(account.name, t("finance.import.defaults.accountFallback"))}</option>;
                        })}
                      </Select>
                    </Field>
                    <Field label={t("finance.import.defaults.dateFormat")}>
                      <Select value={dateFormat} onValueChange={(value) => setDateFormat(value)}>
                        <option value="auto">{t("finance.import.defaults.detectAutomatically")}</option>
                        <option value="dd.MM.yyyy">{t("finance.import.defaults.dateDdMmDot")}</option>
                        <option value="dd/MM/yyyy">{t("finance.import.defaults.dateDdMmSlash")}</option>
                        <option value="MM/dd/yyyy">{t("finance.import.defaults.dateMmDdSlash")}</option>
                        <option value="yyyy-MM-dd">{t("finance.import.defaults.dateIso")}</option>
                      </Select>
                    </Field>
                    <Field label={t("finance.import.defaults.decimalSeparator")}>
                      <Select value={decimalSeparator} onValueChange={(value) => setDecimalSeparator(value)}>
                        <option value="auto">{t("finance.import.defaults.detectAutomatically")}</option>
                        <option value=",">{t("finance.import.defaults.comma")}</option>
                        <option value=".">{t("finance.import.defaults.period")}</option>
                      </Select>
                    </Field>
                    <div className={ui.inlineNotice}><ShieldCheck size={16} />{t("finance.import.defaults.fxNotice")}</div>
                  </div>
                </Section>
              </div>
              <div className={ui.formActions}>
                <Button variant="ghost" onClick={resetImport}>{t("common.actions.cancel")}</Button>
                <Button disabled={working} onClick={() => void createPreview()}>{working ? t("finance.import.actions.validating") : t("finance.import.actions.validatePreview")}</Button>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div>
              <div className={ui.previewStats}>
                <Pill tone="positive">{t("finance.import.preview.valid", { count: numberFrom(summary.validCount ?? summary.valid, previewRows.filter((row) => readRecord(row).valid === true && !readRecord(row).duplicate).length) })}</Pill>
                <Pill tone={previewErrors.length ? "negative" : "neutral"}>{t("finance.import.preview.errors", { count: numberFrom(summary.errorCount ?? summary.invalid, previewRows.filter((row) => readRecord(row).valid === false).length) })}</Pill>
                <Pill tone={previewDuplicates.length ? "warning" : "neutral"}>{t("finance.import.preview.duplicates", { count: numberFrom(summary.duplicateCount ?? summary.duplicates, previewDuplicates.length) })}</Pill>
                <Pill>{t("finance.import.preview.rows", { count: numberFrom(summary.totalCount ?? summary.total, previewRows.length + previewErrors.length) })}</Pill>
              </div>
              <Section title={t("finance.import.preview.title")} description={t("finance.import.preview.description")}>
                <ResponsiveTable label={t("finance.import.preview.tableLabel")}>
                  <thead><tr><th>{t("finance.import.preview.columns.row")}</th><th>{t("finance.import.preview.columns.date")}</th><th>{t("finance.import.preview.columns.merchant")}</th><th>{t("finance.import.preview.columns.account")}</th><th>{t("finance.import.preview.columns.category")}</th><th>{t("finance.import.preview.columns.status")}</th><th>{t("finance.import.preview.columns.amount")}</th></tr></thead>
                  <tbody>
                    {previewRows.slice(0, 50).map((item, index) => {
                      const row = readRecord(item);
                      const valid = row.valid !== false && !row.error;
                      const validationMessage = Array.isArray(row.validationErrors)
                        ? row.validationErrors.map((message) => translateImportError(translator, message)).join(" · ")
                        : row.message || row.error
                          ? translateImportError(translator, row.message ?? row.error)
                          : "";
                      const postedAmountMinor = numberFrom(row.amountMinor);
                      const originalAmountMinor = numberFrom(row.originalAmountMinor);
                      const originalCurrency = stringFrom(row.originalCurrency);
                      const accountCurrency = stringFrom(row.currency ?? row.accountCurrency, defaultAccountCurrency);
                      const originalSignedAmount = postedAmountMinor < 0 ? -Math.abs(originalAmountMinor) : Math.abs(originalAmountMinor);
                      const effectiveRate = formatFxRate(row.fxRateScaled);
                      return (
                        <tr key={String(row.rowNumber ?? index)}>
                          <td>{String(row.rowNumber ?? index + 2)}</td>
                          <td>{formatDate(row.date)}</td>
                          <td>
                            <span className={ui.tablePrimary}>{stringFrom(row.merchant ?? row.description, "—")}</span>
                            {validationMessage ? <span className={`${ui.tableSecondary} ${valid ? "" : ui.negative}`}>{validationMessage}</span> : null}
                          </td>
                          <td>{stringFrom(row.accountName, t("finance.import.preview.defaultAccount"))}</td>
                          <td>{stringFrom(row.categoryName, t("finance.import.preview.uncategorised"))}</td>
                          <td><Pill tone={row.duplicate ? "warning" : valid ? "positive" : "negative"}>{row.duplicate ? t("finance.import.preview.duplicate") : valid ? t("finance.import.preview.validStatus") : t("finance.import.preview.errorStatus")}</Pill></td>
                          <td className={`${ui.amount} ${postedAmountMinor >= 0 ? ui.positive : ui.negative}`}>
                            {formatMoney(postedAmountMinor, accountCurrency)}
                            {originalAmountMinor > 0 && originalCurrency ? (
                              <small className={ui.tableSecondary}>
                                {effectiveRate
                                  ? t("finance.import.preview.originalAmountWithRate", { amount: formatMoney(originalSignedAmount, originalCurrency), originalCurrency, rate: effectiveRate, accountCurrency })
                                  : t("finance.import.preview.originalAmount", { amount: formatMoney(originalSignedAmount, originalCurrency) })}
                              </small>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </ResponsiveTable>
              </Section>
              {invalidPreviewRows.length + previewErrors.length ? (
                <div className={`${ui.inlineNotice} ${ui.inlineNoticeDanger}`}>
                  <span>{t("finance.import.preview.invalidRows", { count: invalidPreviewRows.length + previewErrors.length })}</span>
                </div>
              ) : null}
              <div className={`${ui.formGrid} ${ui.formOffset}`}>
                <Field label={t("finance.import.preview.duplicateHandling")} hint={t("finance.import.preview.duplicateHint")}>
                  <Select value={duplicateHandling} onValueChange={(value) => setDuplicateHandling(value)}>
                    <option value="skip">{t("finance.import.preview.skipDuplicates")}</option>
                    <option value="import">{t("finance.import.preview.importDuplicates")}</option>
                  </Select>
                </Field>
              </div>
              <div className={ui.formActions}>
                <Button variant="ghost" onClick={() => setStep(2)}>{t("finance.import.actions.backToMapping")}</Button>
                <Button disabled={working || !previewRows.length} onClick={() => void commitImport()}>{working ? t("finance.import.actions.importing") : t("finance.import.actions.importValid")}</Button>
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className={`${ui.dropZone} ${ui.staticDropZone}`}>
              <Check size={32} />
              <strong>{t("finance.import.result.completeTitle")}</strong>
              <small>{success ?? t("finance.import.result.completeDescription")}</small>
              <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={resetImport}>{t("finance.import.actions.importAnother")}</Button>
            </div>
          ) : null}
        </div>
      </Section>
    </Page>
  );
}
