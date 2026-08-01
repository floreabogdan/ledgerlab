"use client";

import Link from "next/link";
import { ArrowRight, Check, FileSpreadsheet, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import Papa from "papaparse";
import { useRef, useState } from "react";
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

const targetFields = [
  ["", "Do not import"],
  ["date", "Date"],
  ["amount", "Posted account amount"],
  ["originalAmount", "Original / merchant amount"],
  ["originalCurrency", "Original currency"],
  ["exchangeRate", "Exchange rate (optional check)"],
  ["kind", "Type / direction"],
  ["merchant", "Merchant / description"],
  ["account", "Account"],
  ["category", "Category"],
  ["notes", "Notes"],
  ["tags", "Tags"],
  ["status", "Status"],
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
      setError("Choose a CSV file.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError("CSV files must be smaller than 20 MB.");
      return;
    }

    const text = await file.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, preview: 6, skipEmptyLines: true });
    const foundHeaders = parsed.meta.fields ?? [];
    if (!foundHeaders.length) {
      setError("The file has no readable header row.");
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
      if (!Object.values(mapping).includes("date")) throw new Error("Map one CSV column to Date.");
      if (!Object.values(mapping).includes("amount")) throw new Error("Map one CSV column to Posted account amount.");
      if (!defaultAccountId) throw new Error("Choose the destination LedgerLab account for this bank file.");
      const hasOriginalAmount = Object.values(mapping).includes("originalAmount");
      const hasOriginalCurrency = Object.values(mapping).includes("originalCurrency");
      const hasExchangeRate = Object.values(mapping).includes("exchangeRate");
      if (hasOriginalAmount !== hasOriginalCurrency) throw new Error("Map Original amount and Original currency together.");
      if (hasExchangeRate && !hasOriginalAmount) throw new Error("An exchange-rate column also requires Original amount and Original currency mappings.");

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
      setError(caught instanceof Error ? caught.message : "Could not validate this CSV");
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
      setSuccess(`${numberFrom(resultRecord.importedCount ?? resultRecord.imported)} transactions imported; ${numberFrom(resultRecord.skippedCount ?? resultRecord.skipped)} skipped.`);
      setStep(4);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not import transactions");
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
        eyebrow="Transactions"
        title="Import transactions"
        description="Bring in bank CSV files through a validated preview, explicit column mapping and duplicate review before anything is saved."
        actions={<Link href="/import-export" className={`${kit.button} ${kit.button_secondary}`}>Data &amp; backups</Link>}
      />
      <FormMessage error={error} success={success} />

      <Section title="CSV import" description="Nothing is written until preview validation succeeds and you confirm the import">
        <div className={ui.contentInset}>
          <div className={ui.stepper} aria-label={`Import step ${step} of 4`}>
            {["Choose file", "Map columns", "Review", "Complete"].map((label, index) => (
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
              <strong>Choose or drop a bank CSV</strong>
              <small>LedgerLab reads the header and a small sample locally, then sends the content for validated preview. Maximum 20 MB.</small>
              <Button type="button" variant="secondary" icon={<Upload size={15} />} onClick={() => importRef.current?.click()}>Choose CSV</Button>
              <input ref={importRef} className={ui.hiddenFile} type="file" accept=".csv,text/csv" onChange={(event) => void chooseCsv(event.target.files?.[0])} />
            </label>
          ) : null}

          {step === 2 ? (
            <div>
              <div className={ui.toolbar}>
                <div>
                  <strong>{fileName}</strong>
                  <div className={`${ui.small} ${ui.muted}`}>{headers.length} columns detected</div>
                </div>
                <Button variant="ghost" onClick={resetImport}>Choose another file</Button>
              </div>
              <div className={ui.twoColumn}>
                <Section title="Column mapping" description="Date and posted account amount are required; foreign-currency details are optional">
                  <div className={`${ui.contentInsetCompact} ${ui.verticalStackCompact}`}>
                    {headers.map((header) => (
                      <div className={ui.mappingGrid} key={header}>
                        <strong>{header}<small className={ui.tableSecondary}>{sample[0]?.[header] || "Empty sample"}</small></strong>
                        <span><ArrowRight size={16} /></span>
                        <Select
                          aria-label={`Map ${header}`}
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
                          {targetFields.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                        </Select>
                      </div>
                    ))}
                  </div>
                </Section>
                <Section title="Import defaults" description="Applied when a mapped value is missing">
                  <div className={`${ui.contentInsetCompact} ${ui.verticalStack}`}>
                    <Field label="Default account">
                      <Select value={defaultAccountId} onValueChange={(value) => setDefaultAccountId(value)}>
                        <option value="">Choose an account</option>
                        {accounts.map((item, index) => {
                          const account = readRecord(item);
                          return <option value={String(account.id)} key={stringFrom(account.id, String(index))}>{stringFrom(account.name, "Account")}</option>;
                        })}
                      </Select>
                    </Field>
                    <Field label="Date format">
                      <Select value={dateFormat} onValueChange={(value) => setDateFormat(value)}>
                        <option value="auto">Detect automatically</option>
                        <option value="dd.MM.yyyy">DD.MM.YYYY</option>
                        <option value="dd/MM/yyyy">DD/MM/YYYY</option>
                        <option value="MM/dd/yyyy">MM/DD/YYYY</option>
                        <option value="yyyy-MM-dd">YYYY-MM-DD</option>
                      </Select>
                    </Field>
                    <Field label="Decimal separator">
                      <Select value={decimalSeparator} onValueChange={(value) => setDecimalSeparator(value)}>
                        <option value="auto">Detect automatically</option>
                        <option value=",">Comma (1.234,56)</option>
                        <option value=".">Period (1,234.56)</option>
                      </Select>
                    </Field>
                    <div className={ui.inlineNotice}><ShieldCheck size={16} />Posted amounts use the selected account currency. Map Original amount and Original currency together. The exchange-rate column is optional: LedgerLab derives the effective bank rate from both amounts and uses a mapped rate to verify that they reconcile.</div>
                  </div>
                </Section>
              </div>
              <div className={ui.formActions}>
                <Button variant="ghost" onClick={resetImport}>Cancel</Button>
                <Button disabled={working} onClick={() => void createPreview()}>{working ? "Validating…" : "Validate & preview"}</Button>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div>
              <div className={ui.previewStats}>
                <Pill tone="positive">{numberFrom(summary.validCount ?? summary.valid, previewRows.filter((row) => readRecord(row).valid === true && !readRecord(row).duplicate).length)} valid</Pill>
                <Pill tone={previewErrors.length ? "negative" : "neutral"}>{numberFrom(summary.errorCount ?? summary.invalid, previewRows.filter((row) => readRecord(row).valid === false).length)} errors</Pill>
                <Pill tone={previewDuplicates.length ? "warning" : "neutral"}>{numberFrom(summary.duplicateCount ?? summary.duplicates, previewDuplicates.length)} possible duplicates</Pill>
                <Pill>{numberFrom(summary.totalCount ?? summary.total, previewRows.length + previewErrors.length)} rows</Pill>
              </div>
              <Section title="Import preview" description="A sample of normalized values; amounts below are not saved yet">
                <ResponsiveTable label="CSV import preview">
                  <thead><tr><th>Row</th><th>Date</th><th>Merchant</th><th>Account</th><th>Category</th><th>Status</th><th>Amount</th></tr></thead>
                  <tbody>
                    {previewRows.slice(0, 50).map((item, index) => {
                      const row = readRecord(item);
                      const valid = row.valid !== false && !row.error;
                      const validationMessage = Array.isArray(row.validationErrors)
                        ? row.validationErrors.map((message) => stringFrom(message)).filter(Boolean).join(" · ")
                        : stringFrom(row.message ?? row.error);
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
                          <td>{stringFrom(row.accountName, "Default")}</td>
                          <td>{stringFrom(row.categoryName, "Uncategorised")}</td>
                          <td><Pill tone={row.duplicate ? "warning" : valid ? "positive" : "negative"}>{row.duplicate ? "duplicate" : valid ? "valid" : "error"}</Pill></td>
                          <td className={`${ui.amount} ${postedAmountMinor >= 0 ? ui.positive : ui.negative}`}>
                            {formatMoney(postedAmountMinor, accountCurrency)}
                            {originalAmountMinor > 0 && originalCurrency ? (
                              <small className={ui.tableSecondary}>
                                Original {formatMoney(originalSignedAmount, originalCurrency)}
                                {effectiveRate ? ` · 1 ${originalCurrency} = ${effectiveRate} ${accountCurrency}` : ""}
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
                  <span><strong>{invalidPreviewRows.length + previewErrors.length} rows cannot be imported.</strong> Correct the source CSV or continue to import valid rows only. Invalid rows are always skipped.</span>
                </div>
              ) : null}
              <div className={`${ui.formGrid} ${ui.formOffset}`}>
                <Field label="Possible duplicate handling" hint="Duplicate candidates use account, date, signed amount and normalized merchant.">
                  <Select value={duplicateHandling} onValueChange={(value) => setDuplicateHandling(value)}>
                    <option value="skip">Skip possible duplicates (recommended)</option>
                    <option value="import">Import them anyway</option>
                  </Select>
                </Field>
              </div>
              <div className={ui.formActions}>
                <Button variant="ghost" onClick={() => setStep(2)}>Back to mapping</Button>
                <Button disabled={working || !previewRows.length} onClick={() => void commitImport()}>{working ? "Importing…" : "Import valid transactions"}</Button>
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className={`${ui.dropZone} ${ui.staticDropZone}`}>
              <Check size={32} />
              <strong>Import complete</strong>
              <small>{success ?? "The valid rows are now actual transactions and account balances have been reconciled."}</small>
              <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={resetImport}>Import another file</Button>
            </div>
          ) : null}
        </div>
      </Section>
    </Page>
  );
}
