"use client";

import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  CheckCircle2,
  Copy,
  Download,
  FileUp,
  Filter,
  Paperclip,
  Plus,
  ReceiptText,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDateRange } from "@/components/date-range-context";
import { CurrencyCombobox } from "@/components/ui/currency-combobox";
import { currencyMinorUnitDigits } from "@/lib/domain/currency";
import {
  convertCurrencyMinor,
  deriveRateScaled,
  FX_RATE_SCALE,
  rateInputToScaled,
  rateScaledToInput,
} from "@/lib/domain/fx-math";
import { DEFAULT_CURRENCY, isSupportedCurrency } from "@/lib/currencies";
import {
  AddButton,
  Button,
  DataState,
  Field,
  FilterBar,
  FormMessage,
  formatDate,
  formatMoney,
  IconButton,
  Input,
  isoToday,
  Modal,
  moneyInputToMinor,
  minorToInput,
  numberFrom,
  Page,
  Pill,
  readList,
  readRecord,
  RequestError,
  requestJson,
  ResponsiveTable,
  SearchField,
  Section,
  Select,
  stringFrom,
  Textarea,
  useJson,
  useSubmit,
  ViewHeader,
  workspaceLocale,
  featureStyles as kit,
} from "../_components/feature-kit";
import ui from "../_components/pages.module.css";

type Row = Record<string, unknown>;
type Kind = "expense" | "income" | "transfer" | "refund" | "adjustment";
type SplitDraft = { categoryId: string; amount: string };
type FxQuote = {
  requestedDate: string;
  rateDate: string;
  fromCurrency: string;
  toCurrency: string;
  rateScaled: number;
  rateScale: number;
  fromMinorUnitDigits: number;
  toMinorUnitDigits: number;
  source: "bnr";
  isFallback: boolean;
  fallbackDays: number;
  cacheStatus?: string;
  isStale?: boolean;
  refreshError?: string | null;
  provider: string;
  sourceUrls: string[];
};

function formatRate(value: number, rateScale = FX_RATE_SCALE) {
  return new Intl.NumberFormat(workspaceLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 8 })
    .format(value / rateScale);
}

function signedAmount(transaction: Row) {
  const amount = numberFrom(transaction.amountMinor);
  const kind = stringFrom(transaction.kind ?? transaction.type, "expense");
  if (kind === "expense") return -Math.abs(amount);
  if (kind === "income" || kind === "refund") return Math.abs(amount);
  return amount;
}

function amountTone(value: number) {
  return value > 0 ? ui.positive : value < 0 ? ui.negative : "";
}

function transactionTagNames(transaction: Row) {
  const rawTags = transaction.tags;
  if (Array.isArray(rawTags)) {
    return rawTags
      .map((tag) => stringFrom(readRecord(tag).name, String(tag)).trim())
      .filter(Boolean);
  }
  return stringFrom(rawTags).split(",").map((tag) => tag.trim()).filter(Boolean);
}

function initialSplitDrafts(transaction: Row | null, currency = DEFAULT_CURRENCY): SplitDraft[] {
  if (!Array.isArray(transaction?.splits)) return [];
  return transaction.splits.map((item) => {
    const split = readRecord(item);
    return {
      categoryId: stringFrom(split.categoryId),
      amount: minorToInput(Math.abs(numberFrom(split.amountMinor)), currency),
    };
  });
}

function transactionEntryAccounts(accounts: Row[], kind: Kind) {
  return accounts.filter((item) => {
    const accountType = stringFrom(readRecord(item).type);
    if (kind === "transfer" || kind === "adjustment") {
      return accountType !== "loan" && accountType !== "credit_card";
    }
    return accountType !== "loan";
  });
}

function transactionCategoryKind(kind: Kind): "income" | "expense" | null {
  if (kind === "income") return "income";
  if (kind === "expense" || kind === "refund") return "expense";
  return null;
}

function categorySupportsKind(category: Row, kind: "income" | "expense" | null) {
  if (!kind) return true;
  const categoryKind = stringFrom(readRecord(category).kind, "expense");
  return categoryKind === kind || categoryKind === "both";
}

function categoryPathLabel(category: Row) {
  const row = readRecord(category);
  return stringFrom(row.path, stringFrom(row.parentName)
    ? `${stringFrom(row.parentName)} › ${stringFrom(row.name, "Category")}`
    : stringFrom(row.name, "Category"));
}

async function uploadTransactionReceipt(transactionId: string, file: File) {
  const params = new URLSearchParams({ filename: file.name });
  const response = await fetch(`/api/transactions/${encodeURIComponent(transactionId)}/attachments?${params.toString()}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });
  const body = readRecord(await response.json().catch(() => null));
  if (!response.ok) {
    throw new Error(stringFrom(body.error ?? body.message, `Receipt upload failed (${response.status})`));
  }
}

function useDebouncedValue<T>(value: T, delayMs = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);
  return debounced;
}

export default function TransactionsPage() {
  const { range } = useDateRange();
  const [entryOpen, setEntryOpen] = useState(false);
  const [entrySeed, setEntrySeed] = useState<Row | null>(null);
  const [search, setSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [accountFilter, setAccountFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [fromDate, setFromDate] = useState(range.from);
  const [toDate, setToDate] = useState(range.to);
  const [minimum, setMinimum] = useState("");
  const [maximum, setMaximum] = useState("");
  const [filterCurrency, setFilterCurrency] = useState(DEFAULT_CURRENCY);
  const [mixedAccountCurrencies, setMixedAccountCurrencies] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [clearingId, setClearingId] = useState<string | null>(null);
  const [attachmentTransaction, setAttachmentTransaction] = useState<Row | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pageSize = 100;
  const deferredSearch = useDebouncedValue(search.trim());
  const deferredMinimum = useDebouncedValue(minimum.trim());
  const deferredMaximum = useDebouncedValue(maximum.trim());
  const transactionsUrl = useMemo(() => {
    const params = new URLSearchParams({
      from: fromDate || range.from,
      to: toDate || range.to,
      limit: String(pageSize),
      offset: String(pageIndex * pageSize),
    });
    if (deferredSearch) params.set("q", deferredSearch);
    if (accountFilter) params.set("account", accountFilter);
    if (categoryFilter) params.set("category", categoryFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (kindFilter) params.set("kind", kindFilter);
    if (tagFilter) params.set("tag", tagFilter);
    const amountFilterEnabled = !mixedAccountCurrencies || Boolean(accountFilter);
    const minimumMinor = amountFilterEnabled && deferredMinimum ? moneyInputToMinor(deferredMinimum, filterCurrency) : null;
    const maximumMinor = amountFilterEnabled && deferredMaximum ? moneyInputToMinor(deferredMaximum, filterCurrency) : null;
    if (minimumMinor !== null) params.set("minMinor", String(Math.abs(minimumMinor)));
    if (maximumMinor !== null) params.set("maxMinor", String(Math.abs(maximumMinor)));
    return `/api/transactions?${params.toString()}`;
  }, [accountFilter, categoryFilter, deferredMaximum, deferredMinimum, deferredSearch, filterCurrency, fromDate, kindFilter, mixedAccountCurrencies, pageIndex, range.from, range.to, statusFilter, tagFilter, toDate]);
  const { data: raw, loading, error, reload } = useJson<Record<string, unknown>>(transactionsUrl, {});
  const transactions = readList<Row>(raw, "transactions");
  const accounts = readList<Row>(raw, "accounts").filter((item) => !Boolean(readRecord(item).archivedAt ?? readRecord(item).isArchived));
  const workspaceCurrency = stringFrom(readRecord(raw).currency, DEFAULT_CURRENCY).toUpperCase();
  const selectedFilterAccount = readRecord(accounts.find((item) => stringFrom(readRecord(item).id) === accountFilter));
  const desiredFilterCurrency = accountFilter
    ? stringFrom(selectedFilterAccount.currency, workspaceCurrency).toUpperCase()
    : workspaceCurrency;
  const amountFilterEnabled = !mixedAccountCurrencies || Boolean(accountFilter);
  const categories = readList<Row>(raw, "categories");
  const tags = readList<Row>(raw, "tags");
  const total = Math.max(0, numberFrom(readRecord(raw).total, transactions.length));
  const summary = readRecord(readRecord(raw).summary);
  const clearedCount = Math.max(0, numberFrom(summary.clearedCount));
  const monetaryTotalsAvailable = summary.monetaryTotalsAvailable !== false;
  const actualIncome = numberFrom(summary.incomeMinor);
  const actualSpending = Math.max(0, numberFrom(summary.netSpendingMinor));
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const minimumInputMinor = minimum.trim() ? moneyInputToMinor(minimum, filterCurrency) : null;
  const maximumInputMinor = maximum.trim() ? moneyInputToMinor(maximum, filterCurrency) : null;
  const amountFilterError = !amountFilterEnabled && (minimum.trim() || maximum.trim())
    ? "Choose one account before filtering by amount; native account currencies cannot be compared as raw minor units."
    : minimum.trim() && minimumInputMinor === null
      ? `Enter a valid minimum amount in ${filterCurrency}; this filter is not applied yet.`
      : maximum.trim() && maximumInputMinor === null
        ? `Enter a valid maximum amount in ${filterCurrency}; this filter is not applied yet.`
        : null;
  const hasActiveFilters = Boolean(
    search || accountFilter || categoryFilter || statusFilter || kindFilter || tagFilter
    || minimum || maximum || fromDate !== range.from || toDate !== range.to,
  );

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("new") === "1") {
      queueMicrotask(() => {
        setEntrySeed(null);
        setEntryOpen(true);
      });
    }
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setFromDate(range.from);
      setToDate(range.to);
      setPageIndex(0);
    });
    return () => {
      active = false;
    };
  }, [range.from, range.to]);

  useEffect(() => {
    if (desiredFilterCurrency === filterCurrency) return;
    let active = true;
    queueMicrotask(() => {
      if (active) setFilterCurrency(desiredFilterCurrency);
    });
    return () => {
      active = false;
    };
  }, [desiredFilterCurrency, filterCurrency]);

  useEffect(() => {
    const currencies = new Set(accounts.map((item) => stringFrom(readRecord(item).currency, workspaceCurrency).toUpperCase()));
    const mixed = currencies.size > 1;
    if (mixed === mixedAccountCurrencies) return;
    queueMicrotask(() => setMixedAccountCurrencies(mixed));
  }, [accounts, mixedAccountCurrencies, workspaceCurrency]);

  const resetFilters = () => {
    setSearch(""); setAccountFilter(""); setCategoryFilter(""); setStatusFilter(""); setKindFilter(""); setTagFilter(""); setFromDate(range.from); setToDate(range.to); setMinimum(""); setMaximum(""); setPageIndex(0);
  };

  const openEntry = (seed: Row | null = null) => {
    setEntrySeed(seed);
    setEntryOpen(true);
  };

  async function clearPending(row: Row) {
    const id = stringFrom(row.id);
    if (!id || clearingId) return;
    setClearingId(id);
    setActionError(null);
    try {
      await requestJson(`/api/transactions/${encodeURIComponent(id)}/clear`, {
        method: "POST",
        body: JSON.stringify({ action: "clear" }),
      });
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not mark this transaction as cleared");
    } finally {
      setClearingId(null);
    }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow="Actual money"
        title="Transactions"
        description="Fast entry, transfers, splits and detailed filtering. Transfers are paired and never counted as income or spending."
        actions={
          <>
            <Link className={`${kit.button} ${kit.button_secondary}`} href="/import"><FileUp size={16} /> Import CSV</Link>
            <AddButton onClick={() => openEntry()}>Add transaction</AddButton>
          </>
        }
      />

      <Section
        title="Activity ledger"
        description={`${total.toLocaleString(workspaceLocale())} matching transaction${total === 1 ? "" : "s"} · ${clearedCount.toLocaleString(workspaceLocale())} cleared across the selected filters`}
        action={
          <div className={ui.toolbarGroup}>
            <span className={`${ui.small} ${ui.muted}`}>Cleared income <strong className={ui.positive}>{monetaryTotalsAvailable ? formatMoney(actualIncome, workspaceCurrency) : "Unavailable"}</strong></span>
            <span className={`${ui.small} ${ui.muted}`}>Cleared net spending <strong className={ui.negative}>{monetaryTotalsAvailable ? formatMoney(actualSpending, workspaceCurrency) : "Unavailable"}</strong></span>
          </div>
        }
      >
        <FilterBar>
          <SearchField value={search} onChange={(value) => { setSearch(value); setPageIndex(0); }} placeholder="Search merchant, note, category…" />
          <Select aria-label="Account filter" value={accountFilter} onValueChange={(value) => { setAccountFilter(value); setPageIndex(0); }}>
            <option value="">All accounts</option>
            {accounts.map((item, index) => { const account = readRecord(item); return <option value={String(account.id)} key={stringFrom(account.id, String(index))}>{stringFrom(account.name, "Account")}</option>; })}
          </Select>
          <Select aria-label="Type filter" value={kindFilter} onValueChange={(value) => { setKindFilter(value); setPageIndex(0); }}>
            <option value="">All types</option>
            <option value="expense">Expense</option><option value="income">Income</option><option value="transfer">Transfer</option><option value="refund">Refund</option><option value="adjustment">Adjustment</option>
          </Select>
          <Button variant={showFilters ? "secondary" : "ghost"} icon={<SlidersHorizontal size={15} />} onClick={() => setShowFilters((value) => !value)}>
            More filters
          </Button>
          <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={resetFilters}>Reset</Button>
        </FilterBar>
        {showFilters ? (
          <FilterBar>
            <Input aria-label="From date" type="date" min={range.from} max={range.to} value={fromDate} onChange={(event) => { setFromDate(event.target.value); setPageIndex(0); }} />
            <Input aria-label="To date" type="date" min={range.from} max={range.to} value={toDate} onChange={(event) => { setToDate(event.target.value); setPageIndex(0); }} />
            <Select aria-label="Category filter" value={categoryFilter} onValueChange={(value) => { setCategoryFilter(value); setPageIndex(0); }}>
              <option value="">All categories</option>
              {categories.map((item, index) => { const category = readRecord(item); return <option value={String(category.id)} key={stringFrom(category.id, String(index))}>{stringFrom(category.name, "Category")}</option>; })}
            </Select>
            <Select aria-label="Status filter" value={statusFilter} onValueChange={(value) => { setStatusFilter(value); setPageIndex(0); }}>
              <option value="">Any status</option><option value="cleared">Cleared</option><option value="pending">Pending</option><option value="void">Void</option>
            </Select>
            <Select aria-label="Tag filter" value={tagFilter} onValueChange={(value) => { setTagFilter(value); setPageIndex(0); }}>
              <option value="">All tags</option>
              {tags.map((item, index) => { const tag = readRecord(item); const name = stringFrom(tag.name, String(item)); return <option value={name} key={stringFrom(tag.id, String(index))}>{name}</option>; })}
            </Select>
            <Input
              aria-label={amountFilterEnabled ? `Minimum amount (${filterCurrency})` : "Minimum amount (choose an account first)"}
              aria-invalid={Boolean(minimum.trim() && minimumInputMinor === null)}
              disabled={!amountFilterEnabled}
              inputMode="decimal"
              placeholder={amountFilterEnabled ? `Min ${filterCurrency}` : "Choose account for amount"}
              value={minimum}
              onChange={(event) => { setMinimum(event.target.value); setPageIndex(0); }}
            />
            <Input
              aria-label={amountFilterEnabled ? `Maximum amount (${filterCurrency})` : "Maximum amount (choose an account first)"}
              aria-invalid={Boolean(maximum.trim() && maximumInputMinor === null)}
              disabled={!amountFilterEnabled}
              inputMode="decimal"
              placeholder={amountFilterEnabled ? `Max ${filterCurrency}` : "Choose account for amount"}
              value={maximum}
              onChange={(event) => { setMaximum(event.target.value); setPageIndex(0); }}
            />
          </FilterBar>
        ) : null}
        <FormMessage error={amountFilterError ?? actionError ?? (!monetaryTotalsAvailable ? `Reporting totals are unavailable because one or more ${workspaceCurrency} conversion rates are missing. Native transaction amounts remain accurate.` : null)} />

        <DataState
          loading={loading}
          error={error}
          onRetry={reload}
          empty={!transactions.length}
          emptyTitle={total ? "No transactions on this page" : hasActiveFilters ? "No matching transactions" : "No transactions yet"}
          emptyDescription={total ? "Return to an earlier page." : hasActiveFilters ? "Try broadening or resetting the current filters." : "Record an expense, income or transfer. Actual balances update immediately."}
          action={total
            ? <Button variant="secondary" onClick={() => setPageIndex(0)}>First page</Button>
            : hasActiveFilters
              ? <Button variant="secondary" icon={<Filter size={15} />} onClick={resetFilters}>Reset filters</Button>
              : <AddButton onClick={() => openEntry()}>Add transaction</AddButton>}
        >
          <ResponsiveTable label="Transactions">
            <thead><tr><th>Date</th><th>Merchant / description</th><th>Category</th><th>Account</th><th>Status</th><th>Amount</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {transactions.map((item, index) => {
                const row = readRecord(item);
                const amount = signedAmount(row);
                const kind = stringFrom(row.kind ?? row.type, "expense");
                const rowTags = transactionTagNames(row).slice(0, 2);
                const accountCurrency = stringFrom(row.accountCurrency ?? row.currency, DEFAULT_CURRENCY);
                const originalCurrency = stringFrom(row.originalCurrency);
                const originalAmountMinor = numberFrom(row.originalAmountMinor);
                const hasOriginalAmount = Boolean(originalCurrency && originalCurrency !== accountCurrency && originalAmountMinor > 0);
                const pairedCurrency = stringFrom(row.toCurrency);
                const pairedAmountMinor = numberFrom(row.toAmountMinor);
                const originalSignedAmount = amount < 0 ? -originalAmountMinor : originalAmountMinor;
                const fxSource = stringFrom(row.fxRateSource);
                const fxDetail = fxSource === "bnr"
                  ? `BNR reference${row.fxRateDate ? ` · ${formatDate(row.fxRateDate, { day: "2-digit", month: "short", year: undefined })}` : ""}`
                  : fxSource === "manual"
                    ? `Manual exchange rate${row.referenceFxRateScaled ? " · BNR reference retained" : ""}`
                    : "Foreign-currency amount";
                return (
                  <tr key={stringFrom(row.id, String(index))}>
                    <td className={ui.nowrap}>{formatDate(row.date, { day: "2-digit", month: "short", year: "2-digit" })}</td>
                    <td>
                      <span className={ui.tablePrimary}>{stringFrom(row.merchantName ?? row.merchant ?? row.description, kind.replaceAll("_", " "))}</span>
                      <span className={ui.tableSecondary}>{stringFrom(row.notes ?? row.note, kind === "transfer" ? "Internal transfer — excluded from totals" : "")}</span>
                      {rowTags.length ? <span className={ui.tagList}>{rowTags.map((tag) => <Pill key={tag}>{tag}</Pill>)}</span> : null}
                    </td>
                    <td><span className={ui.categoryDot} style={{ "--category-color": stringFrom(row.categoryColor, "#2563eb") } as React.CSSProperties} />{stringFrom(row.categoryName ?? row.category, kind === "transfer" ? "Transfer" : "Uncategorised")}{Number(row.splitCount) > 1 ? <small>{Number(row.splitCount)}-way split</small> : null}</td>
                    <td>{stringFrom(row.accountName ?? row.account, "Account")}{row.toAccountName ? <small>→ {stringFrom(row.toAccountName)}</small> : null}</td>
                    <td><Pill tone={stringFrom(row.status) === "pending" ? "warning" : stringFrom(row.status) === "void" ? "negative" : "positive"}>{stringFrom(row.status, "cleared")}</Pill></td>
                    <td className={`${ui.amount} ${amountTone(amount)}`}>
                      {amount > 0 ? "+" : ""}{formatMoney(amount, accountCurrency)}
                      {hasOriginalAmount ? (
                        <small className={ui.fxAmountSecondary}>{originalSignedAmount > 0 ? "+" : ""}{formatMoney(originalSignedAmount, originalCurrency)} · {fxDetail}</small>
                      ) : kind === "transfer" && pairedCurrency && pairedAmountMinor > 0 ? (
                        <small className={ui.fxAmountSecondary}>Paired posting {formatMoney(pairedAmountMinor, pairedCurrency)}</small>
                      ) : null}
                    </td>
                    <td>
                      <div className={ui.paymentActions}>
                        {stringFrom(row.status) === "pending" ? (
                          <IconButton label="Mark transaction cleared" disabled={Boolean(clearingId)} onClick={() => void clearPending(row)}>
                            <CheckCircle2 size={15} />
                          </IconButton>
                        ) : null}
                        <IconButton label={`Manage receipts${numberFrom(row.attachmentCount) ? ` (${numberFrom(row.attachmentCount)})` : ""}`} onClick={() => setAttachmentTransaction(row)}>
                          <Paperclip size={15} />
                        </IconButton>
                        <IconButton label="Duplicate transaction" onClick={() => openEntry(row)}><Copy size={15} /></IconButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </ResponsiveTable>
          {total > pageSize ? (
            <div className={ui.pagination} aria-label="Transaction pages">
              <span>
                Showing {(pageIndex * pageSize + 1).toLocaleString(workspaceLocale())}–{Math.min((pageIndex + 1) * pageSize, total).toLocaleString(workspaceLocale())} of {total.toLocaleString(workspaceLocale())} · Page {Math.min(pageIndex + 1, pageCount)} of {pageCount}
              </span>
              <div>
                <Button variant="ghost" disabled={loading || pageIndex === 0} onClick={() => setPageIndex((current) => Math.max(0, current - 1))}>Previous</Button>
                <Button variant="secondary" disabled={loading || (pageIndex + 1) * pageSize >= total} onClick={() => setPageIndex((current) => current + 1)}>Next</Button>
              </div>
            </div>
          ) : null}
        </DataState>
      </Section>

      <TransactionForm
        key={`${entryOpen ? `transaction-form-${stringFrom(entrySeed?.id, "new")}` : "transaction-form-closed"}-${workspaceCurrency}-${accounts.length}`}
        open={entryOpen}
        onClose={() => setEntryOpen(false)}
        onCreated={reload}
        accounts={accounts}
        categories={categories}
        existing={transactions}
        initial={entrySeed}
      />
      {attachmentTransaction ? (
        <AttachmentManager
          key={stringFrom(attachmentTransaction.id)}
          transaction={attachmentTransaction}
          onClose={() => setAttachmentTransaction(null)}
          onChanged={reload}
        />
      ) : null}
    </Page>
  );
}

function AttachmentManager({
  transaction,
  onClose,
  onChanged,
}: {
  transaction: Row;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const transactionId = stringFrom(transaction.id);
  const attachmentsUrl = `/api/transactions/${encodeURIComponent(transactionId)}/attachments`;
  const { data: raw, loading, error, reload } = useJson<Record<string, unknown>>(attachmentsUrl, {});
  const attachments = readList<Row>(raw, "attachments");
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function upload() {
    if (!file || uploading) return;
    if (file.size > 10 * 1024 * 1024) {
      setActionError("Receipt files must not exceed 10 MB.");
      return;
    }
    setUploading(true);
    setActionError(null);
    try {
      await uploadTransactionReceipt(transactionId, file);
      setFile(null);
      setInputKey((current) => current + 1);
      await Promise.all([reload(), onChanged()]);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not upload the receipt.");
    } finally {
      setUploading(false);
    }
  }

  async function remove(attachmentId: string) {
    if (deletingId) return;
    setDeletingId(attachmentId);
    setActionError(null);
    try {
      await requestJson(`/api/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
      setConfirmDeleteId(null);
      await Promise.all([reload(), onChanged()]);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not delete the receipt.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Receipts"
      description={`${stringFrom(transaction.merchantName ?? transaction.merchant ?? transaction.description, "Transaction")} · ${formatDate(transaction.date)}`}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      <div className={ui.receiptManager}>
        <FormMessage error={actionError} />
        <div className={ui.receiptUploadRow}>
          <input
            key={inputKey}
            className="sr-only"
            id="existing-transaction-receipt"
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif,.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif"
            aria-describedby="existing-transaction-receipt-hint"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <label className={`${kit.button} ${kit.button_secondary} ${ui.attachmentPicker}`} htmlFor="existing-transaction-receipt">
            <Paperclip size={15} aria-hidden="true" /> {file ? "Replace selection" : "Choose receipt"}
          </label>
          <span id="existing-transaction-receipt-hint">{file ? `${file.name} · ${new Intl.NumberFormat(workspaceLocale(), { maximumFractionDigits: 1 }).format(file.size / 1024)} KB` : "PDF or image · up to 10 MB"}</span>
          <Button disabled={!file || uploading} onClick={() => void upload()}>{uploading ? "Uploading…" : "Upload"}</Button>
        </div>
        <DataState
          loading={loading}
          error={error}
          onRetry={reload}
          empty={!attachments.length}
          emptyTitle="No receipts attached"
          emptyDescription="Upload a PDF or image to keep it privately with this transaction."
        >
          <div className={ui.receiptList}>
            {attachments.map((item, index) => {
              const row = readRecord(item);
              const id = stringFrom(row.id, String(index));
              const isFile = stringFrom(row.kind) === "file";
              const sizeBytes = numberFrom(row.sizeBytes);
              return (
                <div className={ui.receiptItem} key={id}>
                  <span>
                    <strong>{stringFrom(row.fileName, "Receipt")}</strong>
                    <small>
                      {isFile
                        ? `${stringFrom(row.mimeType, "File")} · ${new Intl.NumberFormat(workspaceLocale(), { maximumFractionDigits: 1 }).format(sizeBytes / 1024)} KB`
                        : stringFrom(row.externalReference, "Legacy receipt reference")}
                    </small>
                  </span>
                  <div className={ui.receiptActions}>
                    {isFile ? (
                      <a
                        className={`${kit.button} ${kit.button_ghost}`}
                        href={`/api/attachments/${encodeURIComponent(id)}/download`}
                      >
                        <Download size={15} aria-hidden="true" /> Download
                      </a>
                    ) : null}
                    {confirmDeleteId === id ? (
                      <>
                        <Button variant="danger" disabled={deletingId === id} onClick={() => void remove(id)}>{deletingId === id ? "Deleting…" : "Delete"}</Button>
                        <Button variant="ghost" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
                      </>
                    ) : (
                      <IconButton label={`Delete ${stringFrom(row.fileName, "receipt")}`} onClick={() => setConfirmDeleteId(id)}>
                        <Trash2 size={15} />
                      </IconButton>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </DataState>
      </div>
    </Modal>
  );
}

function TransactionForm({
  open,
  onClose,
  onCreated,
  accounts,
  categories,
  existing,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
  accounts: Row[];
  categories: Row[];
  existing: Row[];
  initial: Row | null;
}) {
  const initialKind = stringFrom(initial?.kind ?? initial?.type, "expense") as Kind;
  const initialEntryAccounts = transactionEntryAccounts(accounts, initialKind);
  const requestedInitialAccountId = stringFrom(initial?.accountId);
  const initialAccount = initialEntryAccounts.find((item) => stringFrom(readRecord(item).id) === requestedInitialAccountId)
    ?? initialEntryAccounts[0];
  const initialAccountId = stringFrom(readRecord(initialAccount).id);
  const initialAccountCurrency = stringFrom(
    initial?.accountCurrency ?? initial?.currency ?? readRecord(initialAccount).currency,
    DEFAULT_CURRENCY,
  ).toUpperCase();
  const initialEnteredCurrency = initialKind === "transfer"
    ? initialAccountCurrency
    : stringFrom(initial?.originalCurrency, initialAccountCurrency).toUpperCase();
  const initialOriginalAmount = initialKind === "transfer" ? 0 : numberFrom(initial?.originalAmountMinor);
  const initialLedgerSignedAmount = initial ? signedAmount(initial) : 0;
  const initialEntryAmount = initialOriginalAmount > 0
    ? (initialKind === "adjustment" && initialLedgerSignedAmount < 0 ? -initialOriginalAmount : initialOriginalAmount)
    : initialKind === "adjustment" ? initialLedgerSignedAmount : Math.abs(initialLedgerSignedAmount);
  const initialSplits = initialSplitDrafts(initial, initialAccountCurrency);
  const [kind, setKind] = useState<Kind>(initialKind);
  const [date, setDate] = useState(stringFrom(initial?.date).slice(0, 10) || isoToday());
  const [accountId, setAccountId] = useState(initialAccountId);
  const [toAccountId, setToAccountId] = useState(stringFrom(initial?.toAccountId ?? initial?.transferAccountId));
  const [amount, setAmount] = useState(initial ? minorToInput(initialEntryAmount, initialEnteredCurrency) : "");
  const [enteredCurrency, setEnteredCurrency] = useState(initialEnteredCurrency);
  const [enteredCurrencyFollowsAccount, setEnteredCurrencyFollowsAccount] = useState(
    initialEnteredCurrency === initialAccountCurrency,
  );
  const [fxQuote, setFxQuote] = useState<FxQuote | null>(null);
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState<string | null>(null);
  const [rateMode, setRateMode] = useState<"reference" | "manual">(stringFrom(initial?.fxRateSource) === "manual" ? "manual" : "reference");
  const [manualRate, setManualRate] = useState(stringFrom(initial?.fxRateSource) === "manual" ? rateScaledToInput(numberFrom(initial?.fxRateScaled)) : "");
  const [useExactAccountAmount, setUseExactAccountAmount] = useState(false);
  const initialExactTargetCurrency = initialKind === "transfer"
    ? stringFrom(initial?.toCurrency, initialAccountCurrency)
    : initialAccountCurrency;
  const initialExactTargetAmount = initialKind === "transfer"
    ? numberFrom(initial?.toAmountMinor, Math.abs(initialLedgerSignedAmount))
    : Math.abs(initialLedgerSignedAmount);
  const [exactAccountAmount, setExactAccountAmount] = useState(initial ? minorToInput(initialExactTargetAmount, initialExactTargetCurrency) : "");
  const fxInputKeyRef = useRef<string | null>(null);
  const [merchant, setMerchant] = useState(stringFrom(initial?.merchantName ?? initial?.merchant));
  const [categoryId, setCategoryId] = useState(stringFrom(initial?.categoryId));
  const [createdCategories, setCreatedCategories] = useState<Row[]>([]);
  const [categoryCreatorOpen, setCategoryCreatorOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryParentId, setNewCategoryParentId] = useState("");
  const [newCategoryNature, setNewCategoryNature] = useState<"fixed" | "variable">("variable");
  const [newCategoryPriority, setNewCategoryPriority] = useState<"essential" | "discretionary">("discretionary");
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [categoryCreateError, setCategoryCreateError] = useState<string | null>(null);
  const [status, setStatus] = useState(stringFrom(initial?.status, "cleared") === "pending" ? "pending" : "cleared");
  const [notes, setNotes] = useState(stringFrom(initial?.notes ?? initial?.note));
  const [tagText, setTagText] = useState(initial ? transactionTagNames(initial).join(", ") : "");
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [attachmentInputKey, setAttachmentInputKey] = useState(0);
  const [pendingAttachmentTransactionId, setPendingAttachmentTransactionId] = useState<string | null>(null);
  const [confirmedDuplicateKey, setConfirmedDuplicateKey] = useState<string | null>(null);
  const [serverDuplicateKey, setServerDuplicateKey] = useState<string | null>(null);
  const [useSplits, setUseSplits] = useState(initialSplits.length > 0);
  const [splits, setSplits] = useState<SplitDraft[]>(initialSplits.length
    ? initialSplits
    : [{ categoryId: "", amount: "" }, { categoryId: "", amount: "" }]);
  const [addAnother, setAddAnother] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);

  const availableCategories = useMemo(() => {
    const sourceIds = new Set(categories.map((item) => stringFrom(readRecord(item).id)));
    return [...categories, ...createdCategories.filter((item) => !sourceIds.has(stringFrom(readRecord(item).id)))];
  }, [categories, createdCategories]);
  const inferredCategoryKind = transactionCategoryKind(kind);
  const selectableCategories = availableCategories.filter((item) => (
    !Boolean(readRecord(item).archivedAt ?? readRecord(item).isArchived)
    && categorySupportsKind(item, inferredCategoryKind)
  ));
  const quickCategoryParents = inferredCategoryKind
    ? selectableCategories.filter((item) => categorySupportsKind(item, inferredCategoryKind))
    : [];

  const entryAccounts = transactionEntryAccounts(accounts, kind);
  const requestedAccountId = accountId || String(readRecord(entryAccounts[0]).id ?? "");
  const selectedAccountId = entryAccounts.some((item) => String(readRecord(item).id) === requestedAccountId)
    ? requestedAccountId
    : String(readRecord(entryAccounts[0]).id ?? "");
  const selectedCurrency = stringFrom(
    readRecord(entryAccounts.find((item) => String(readRecord(item).id) === selectedAccountId)).currency,
    DEFAULT_CURRENCY,
  ).toUpperCase();
  const destinationAccount = readRecord(entryAccounts.find((item) => String(readRecord(item).id) === toAccountId));
  const destinationCurrency = stringFrom(destinationAccount.currency, selectedCurrency).toUpperCase();
  const normalizedEnteredCurrency = enteredCurrency.trim().toUpperCase();
  const enteredCurrencyValid = isSupportedCurrency(normalizedEnteredCurrency);
  const isForeignEntry = kind !== "transfer" && enteredCurrencyValid && normalizedEnteredCurrency !== selectedCurrency;
  const isCrossCurrencyTransfer = kind === "transfer" && Boolean(toAccountId) && destinationCurrency !== selectedCurrency;
  const isCurrencyConversion = isForeignEntry || isCrossCurrencyTransfer;
  const conversionFromCurrency = isCrossCurrencyTransfer ? selectedCurrency : normalizedEnteredCurrency;
  const conversionToCurrency = isCrossCurrencyTransfer ? destinationCurrency : selectedCurrency;
  const parsedAmount = moneyInputToMinor(amount, isForeignEntry ? normalizedEnteredCurrency : selectedCurrency);
  const originalAmountAbsolute = parsedAmount === null ? null : Math.abs(parsedAmount);
  const quoteMatches = Boolean(
    fxQuote && fxQuote.fromCurrency === conversionFromCurrency && fxQuote.toCurrency === conversionToCurrency,
  );
  const referenceRateScaled = quoteMatches ? fxQuote?.rateScaled ?? null : null;
  const rateScale = quoteMatches ? fxQuote?.rateScale ?? FX_RATE_SCALE : FX_RATE_SCALE;
  const sourceDigits = quoteMatches ? fxQuote?.fromMinorUnitDigits ?? 2 : currencyMinorUnitDigits(conversionFromCurrency);
  const targetDigits = quoteMatches ? fxQuote?.toMinorUnitDigits ?? 2 : currencyMinorUnitDigits(conversionToCurrency);
  const parsedManualRateScaled = rateInputToScaled(manualRate, rateScale);
  const parsedExactAccountAmount = moneyInputToMinor(exactAccountAmount, conversionToCurrency);
  const derivedExactRateScaled = isCurrencyConversion && useExactAccountAmount && originalAmountAbsolute && parsedExactAccountAmount
    ? deriveRateScaled(originalAmountAbsolute, Math.abs(parsedExactAccountAmount), rateScale, sourceDigits, targetDigits)
    : null;
  const exactRoundTripAmountMinor = derivedExactRateScaled && originalAmountAbsolute
    ? convertCurrencyMinor(originalAmountAbsolute, derivedExactRateScaled, rateScale, sourceDigits, targetDigits)
    : null;
  const exactAmountReconciles = !useExactAccountAmount || (
    parsedExactAccountAmount !== null && exactRoundTripAmountMinor === Math.abs(parsedExactAccountAmount)
  );
  const activeRateScaled = useExactAccountAmount
    ? derivedExactRateScaled
    : rateMode === "manual" ? parsedManualRateScaled : referenceRateScaled;
  const calculatedAccountAmountMinor = isCurrencyConversion && originalAmountAbsolute !== null && activeRateScaled
    ? convertCurrencyMinor(originalAmountAbsolute, activeRateScaled, rateScale, sourceDigits, targetDigits)
    : null;
  const postedAccountAmountAbsolute = isForeignEntry
    ? useExactAccountAmount
      ? parsedExactAccountAmount === null ? null : Math.abs(parsedExactAccountAmount)
      : calculatedAccountAmountMinor
    : originalAmountAbsolute;
  const destinationAmountAbsolute = kind === "transfer"
    ? isCrossCurrencyTransfer
      ? useExactAccountAmount
        ? parsedExactAccountAmount === null ? null : Math.abs(parsedExactAccountAmount)
        : calculatedAccountAmountMinor
      : originalAmountAbsolute
    : null;
  const normalizedMerchant = merchant.trim().toLocaleLowerCase();
  const submittedSignedAmount = postedAccountAmountAbsolute === null
    ? null
    : kind === "expense" || kind === "transfer"
      ? -postedAccountAmountAbsolute
      : kind === "income" || kind === "refund"
        ? postedAccountAmountAbsolute
        : parsedAmount !== null && parsedAmount < 0 ? -postedAccountAmountAbsolute : postedAccountAmountAbsolute;
  const duplicateKey = JSON.stringify([
    selectedAccountId,
    date,
    submittedSignedAmount,
    kind,
    normalizedMerchant,
  ]);
  const duplicate = submittedSignedAmount !== null && submittedSignedAmount !== 0 && existing.find((item) => {
    const row = readRecord(item);
    return String(row.accountId) === selectedAccountId &&
      String(row.date).slice(0, 10) === date &&
      stringFrom(row.kind ?? row.type) === kind &&
      signedAmount(row) === submittedSignedAmount &&
      stringFrom(row.merchantName ?? row.merchant).trim().toLocaleLowerCase() === normalizedMerchant;
  });
  const duplicateDetected = Boolean(duplicate) || serverDuplicateKey === duplicateKey;
  const duplicateConfirmed = duplicateDetected && confirmedDuplicateKey === duplicateKey;
  const splitTotal = splits.reduce((sum, split) => sum + Math.abs(moneyInputToMinor(split.amount, selectedCurrency) ?? 0), 0);

  useEffect(() => {
    const requestKey = `${kind}|${date}|${conversionFromCurrency}|${conversionToCurrency}`;
    const inputsChanged = fxInputKeyRef.current !== null && fxInputKeyRef.current !== requestKey;
    fxInputKeyRef.current = requestKey;
    const controller = new AbortController();
    let active = true;

    queueMicrotask(() => {
      if (!active) return;
      if (inputsChanged) {
        setRateMode("reference");
        setManualRate("");
        setUseExactAccountAmount(false);
        setExactAccountAmount("");
      }
      if (!isCurrencyConversion || !date) {
        setFxQuote(null);
        setFxError(null);
        setFxLoading(false);
        return;
      }
      setFxLoading(true);
      setFxError(null);
      void (async () => {
        try {
          const params = new URLSearchParams({ date, from: conversionFromCurrency, to: conversionToCurrency });
          const response = await fetch(`/api/fx/quote?${params.toString()}`, {
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          });
          const body = readRecord(await response.json().catch(() => null));
          if (!response.ok) throw new Error(stringFrom(body.error ?? body.message, `Reference rate unavailable (${response.status})`));
          const quote = readRecord(body.quote);
          if (!Number.isSafeInteger(quote.rateScaled) || numberFrom(quote.rateScaled) <= 0) throw new Error("The reference-rate response was invalid.");
          if (active) setFxQuote(quote as FxQuote);
        } catch (error) {
          if (!active || controller.signal.aborted) return;
          setFxQuote(null);
          setFxError(error instanceof Error ? error.message : "No reference rate is available.");
        } finally {
          if (active) setFxLoading(false);
        }
      })();
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [conversionFromCurrency, conversionToCurrency, date, isCurrencyConversion, kind]);

  const resetCategoryCreator = () => {
    setCategoryCreatorOpen(false);
    setNewCategoryName("");
    setNewCategoryParentId("");
    setNewCategoryNature("variable");
    setNewCategoryPriority("discretionary");
    setCategoryCreateError(null);
  };

  async function createAndSelectCategory() {
    const categoryKind = transactionCategoryKind(kind);
    if (!categoryKind) {
      setCategoryCreateError("Create categories from an income, expense, or refund entry.");
      return;
    }
    if (!newCategoryName.trim()) {
      setCategoryCreateError("Enter a category name.");
      return;
    }
    setCreatingCategory(true);
    setCategoryCreateError(null);
    try {
      const parent = quickCategoryParents.find((item) => stringFrom(readRecord(item).id) === newCategoryParentId);
      const response = await requestJson<{ category?: Row }>("/api/categories", {
        method: "POST",
        body: JSON.stringify({
          action: "create",
          name: newCategoryName.trim(),
          parentId: newCategoryParentId || null,
          kind: categoryKind,
          spendingNature: newCategoryNature,
          spendingPriority: newCategoryPriority,
          color: stringFrom(readRecord(parent).color, "#2563eb"),
        }),
      });
      const category = readRecord(response.category);
      const id = stringFrom(category.id);
      if (!id) throw new Error("The category was created, but the response did not include its id.");
      setCreatedCategories((current) => [...current.filter((item) => stringFrom(readRecord(item).id) !== id), category]);
      if (useSplits) {
        setSplits((current) => {
          const emptyIndex = current.findIndex((item) => !item.categoryId);
          if (emptyIndex < 0) return [...current, { categoryId: id, amount: "" }];
          return current.map((item, index) => index === emptyIndex ? { ...item, categoryId: id } : item);
        });
      } else {
        setCategoryId(id);
      }
      resetCategoryCreator();
      await onCreated();
    } catch (caught) {
      setCategoryCreateError(caught instanceof Error ? caught.message : "Could not create the category.");
    } finally {
      setCreatingCategory(false);
    }
  }

  const resetEntry = () => {
    setAmount(""); setMerchant(""); setNotes(""); setTagText(""); setAttachmentFile(null); setAttachmentInputKey((current) => current + 1); setPendingAttachmentTransactionId(null); setCategoryId(""); setConfirmedDuplicateKey(null); setServerDuplicateKey(null); setUseSplits(false); setSplits([{ categoryId: "", amount: "" }, { categoryId: "", amount: "" }]);
    setEnteredCurrency(selectedCurrency); setEnteredCurrencyFollowsAccount(true); setFxQuote(null); setFxError(null); setFxLoading(false); setRateMode("reference"); setManualRate(""); setUseExactAccountAmount(false); setExactAccountAmount(""); fxInputKeyRef.current = null;
    resetCategoryCreator();
  };

  const { submit, submitting, submitError, setSubmitError } = useSubmit(async () => {
    if (attachmentFile && attachmentFile.size > 10 * 1024 * 1024) {
      throw new Error("Receipt files must not exceed 10 MB.");
    }
    if (pendingAttachmentTransactionId) {
      if (!attachmentFile) throw new Error("Choose a receipt file to retry the upload.");
      await uploadTransactionReceipt(pendingAttachmentTransactionId, attachmentFile);
      setPendingAttachmentTransactionId(null);
      setSessionCount((count) => count + 1);
      await onCreated();
      if (addAnother && !initial) resetEntry();
      else { resetEntry(); onClose(); }
      return;
    }
    const rawAmount = moneyInputToMinor(amount, isForeignEntry ? normalizedEnteredCurrency : selectedCurrency);
    if (!selectedAccountId) throw new Error("Choose an account.");
    if (kind !== "transfer" && !enteredCurrencyValid) throw new Error("Choose a supported ISO 4217 currency.");
    if (rawAmount === null || rawAmount === 0) throw new Error(`Enter a valid non-zero amount in ${isForeignEntry ? normalizedEnteredCurrency : selectedCurrency}.`);
    if (kind === "transfer" && (!toAccountId || toAccountId === selectedAccountId)) throw new Error("Choose a different destination account.");
    if (isCurrencyConversion) {
      if (rateMode === "reference" && !referenceRateScaled) throw new Error("Wait for the BNR reference rate or enter the exchange rate manually.");
      if (!activeRateScaled || activeRateScaled <= 0) throw new Error("Enter a positive exchange rate.");
      const convertedAmount = isCrossCurrencyTransfer ? destinationAmountAbsolute : postedAccountAmountAbsolute;
      if (!convertedAmount || convertedAmount <= 0) throw new Error(`Enter or calculate a positive amount in ${conversionToCurrency}.`);
      if (!exactAmountReconciles) throw new Error("This exact account amount cannot be represented by the derived eight-decimal exchange rate. Edit the exchange rate instead.");
    }
    if (useSplits) {
      if (splits.some((split) => !split.categoryId || moneyInputToMinor(split.amount, selectedCurrency) === null)) throw new Error("Complete every split category and amount.");
      if (splitTotal !== postedAccountAmountAbsolute) throw new Error(`Split amounts must add up exactly to the posted ${selectedCurrency} amount.`);
    }
    const originalAbsolute = Math.abs(rawAmount);
    const amountMinor = kind === "adjustment" ? submittedSignedAmount ?? 0 : postedAccountAmountAbsolute ?? 0;
    const fxRateSource = isCurrencyConversion ? (rateMode === "manual" || useExactAccountAmount ? "manual" : "bnr") : null;
    try {
      const created = await requestJson<{ transaction?: { id?: string } }>("/api/transactions", {
        method: "POST",
        body: JSON.stringify({
          kind,
          type: kind,
          status,
          date,
          accountId: selectedAccountId,
          toAccountId: kind === "transfer" ? toAccountId : null,
          amountMinor,
          transferAmountMinor: kind === "transfer" ? destinationAmountAbsolute : null,
          destinationAmountMinor: kind === "transfer" ? destinationAmountAbsolute : null,
          originalAmountMinor: isForeignEntry ? originalAbsolute : null,
          originalCurrency: isForeignEntry ? conversionFromCurrency : null,
          fxRateScaled: isCurrencyConversion ? activeRateScaled : null,
          fxRateSource,
          fxRateDate: isCurrencyConversion ? fxRateSource === "bnr" ? fxQuote?.rateDate : date : null,
          referenceFxRateScaled: isCurrencyConversion && fxRateSource === "manual" && referenceRateScaled ? referenceRateScaled : null,
          referenceFxRateDate: isCurrencyConversion && fxRateSource === "manual" && referenceRateScaled ? fxQuote?.rateDate : null,
          merchant: merchant.trim() || null,
          categoryId: kind === "transfer" || useSplits ? null : categoryId || null,
          notes: notes.trim() || null,
          tags: tagText.split(",").map((tag) => tag.trim()).filter(Boolean),
          duplicateConfirmed,
          splits: useSplits ? splits.map((split) => ({ categoryId: split.categoryId, amountMinor: Math.abs(moneyInputToMinor(split.amount, selectedCurrency) ?? 0) })) : [],
        }),
      });
      const transactionId = stringFrom(readRecord(created.transaction).id);
      if (attachmentFile) {
        if (!transactionId) throw new Error("The transaction was saved, but its receipt could not be linked because the server response had no transaction id.");
        try {
          await uploadTransactionReceipt(transactionId, attachmentFile);
        } catch (error) {
          setPendingAttachmentTransactionId(transactionId);
          await onCreated();
          const reason = error instanceof Error ? error.message : "Receipt upload failed.";
          throw new Error(`Transaction saved, but the receipt was not uploaded. ${reason} Choose a valid file and retry; the transaction will not be created again.`);
        }
      }
    } catch (error) {
      if (error instanceof RequestError && error.status === 409) {
        setServerDuplicateKey(duplicateKey);
      }
      throw error;
    }
    setSessionCount((count) => count + 1);
    await onCreated();
    if (addAnother && !initial) resetEntry();
    else { resetEntry(); onClose(); }
  });

  const close = () => { setSubmitError(null); setSessionCount(0); resetCategoryCreator(); onClose(); };
  const selectedAccountName = stringFrom(readRecord(accounts.find((item) => stringFrom(readRecord(item).id) === selectedAccountId)).name, "selected account");
  const conversionTargetAccountName = isCrossCurrencyTransfer
    ? stringFrom(destinationAccount.name, "destination account")
    : selectedAccountName;
  const displayedRate = useExactAccountAmount
    ? derivedExactRateScaled ? rateScaledToInput(derivedExactRateScaled, rateScale) : ""
    : rateMode === "manual" ? manualRate : referenceRateScaled ? rateScaledToInput(referenceRateScaled, rateScale) : "";
  const displayedAccountAmount = useExactAccountAmount
    ? exactAccountAmount
    : calculatedAccountAmountMinor === null ? "" : minorToInput(calculatedAccountAmountMinor, conversionToCurrency);

  return (
    <Modal
      open={open}
      onClose={close}
      title={initial ? "Duplicate transaction" : "Add transaction"}
      description={sessionCount ? `${sessionCount} transaction${sessionCount === 1 ? "" : "s"} added in this session` : "Record actual activity. Press Ctrl/⌘ + Enter to save."}
      wide
      footer={
        <>
          {!initial ? (
            <label className={`${ui.small} ${ui.footerCheck}`}>
              <input type="checkbox" checked={addAnother} onChange={(event) => setAddAnother(event.target.checked)} /> Keep adding
            </label>
          ) : null}
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button
            disabled={submitting || Boolean(!pendingAttachmentTransactionId && duplicateDetected && !duplicateConfirmed)}
            onClick={() => void submit()}
          >
            {submitting ? "Saving…" : pendingAttachmentTransactionId ? "Retry receipt upload" : addAnother ? "Save & add another" : "Save transaction"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void submit(); }}
      >
        <div className={ui.typeSwitch} role="group" aria-label="Transaction type">
          {([
            ["expense", "Expense", <ArrowUpRight size={14} key="expense" />],
            ["income", "Income", <ArrowDownLeft size={14} key="income" />],
            ["transfer", "Transfer", <ArrowLeftRight size={14} key="transfer" />],
            ["refund", "Refund", <RotateCcw size={14} key="refund" />],
            ["adjustment", "Adjustment", <SlidersHorizontal size={14} key="adjustment" />],
          ] as const).map(([value, label, icon]) => (
            <button type="button" key={value} aria-pressed={kind === value} onClick={() => {
              const nextAccounts = transactionEntryAccounts(accounts, value);
              const nextAccount = nextAccounts.find((item) => stringFrom(readRecord(item).id) === selectedAccountId)
                ?? nextAccounts[0];
              const nextAccountId = stringFrom(readRecord(nextAccount).id);
              const nextCurrency = stringFrom(readRecord(nextAccount).currency, DEFAULT_CURRENCY).toUpperCase();
              const nextCategoryKind = transactionCategoryKind(value);
              const selectedCategory = availableCategories.find((item) => stringFrom(readRecord(item).id) === categoryId);
              setKind(value);
              setUseSplits(false);
              resetCategoryCreator();
              if (value === "transfer" || (nextCategoryKind && selectedCategory && !categorySupportsKind(selectedCategory, nextCategoryKind))) {
                setCategoryId("");
              }
              setAccountId(nextAccountId);
              if (toAccountId === nextAccountId) setToAccountId("");
              if (value === "transfer") {
                setEnteredCurrency(nextCurrency);
                setEnteredCurrencyFollowsAccount(true);
              } else if (enteredCurrencyFollowsAccount) {
                setEnteredCurrency(nextCurrency);
              }
            }}>{icon} {label}</button>
          ))}
        </div>

        <div className={`${ui.formGrid} ${ui.formOffset}`}>
          <Field label="Date">
            <Input type="date" max={isoToday()} value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
          <Field label="Status" hint="Pending means the activity already occurred but has not settled. Use Planned Payments for future cash movements.">
            <Select value={status} onValueChange={(value) => setStatus(value)}><option value="cleared">Cleared</option><option value="pending">Pending</option></Select>
          </Field>
          <Field label={kind === "transfer" ? "From account" : "Account"}>
            <Select value={selectedAccountId} onValueChange={(value) => {
              const nextAccountId = value;
              const nextCurrency = stringFrom(readRecord(accounts.find((item) => stringFrom(readRecord(item).id) === nextAccountId)).currency, DEFAULT_CURRENCY).toUpperCase();
              if (enteredCurrencyFollowsAccount) setEnteredCurrency(nextCurrency);
              setAccountId(nextAccountId);
              if (toAccountId === nextAccountId) setToAccountId("");
            }}>
              <option value="">Choose account</option>
              {entryAccounts.map((item, index) => { const account = readRecord(item); return <option value={String(account.id)} key={stringFrom(account.id, String(index))}>{stringFrom(account.name, "Account")} · {formatMoney(account.balanceMinor ?? account.currentBalanceMinor, stringFrom(account.currency, DEFAULT_CURRENCY))}</option>; })}
            </Select>
          </Field>
          {kind === "transfer" ? (
            <Field label="To account">
              <Select value={toAccountId} onValueChange={(value) => setToAccountId(value)}>
                <option value="">Choose destination</option>
                {entryAccounts.filter((item) => String(readRecord(item).id) !== selectedAccountId).map((item, index) => { const account = readRecord(item); const accountCurrency = stringFrom(account.currency, DEFAULT_CURRENCY); return <option value={String(account.id)} key={stringFrom(account.id, String(index))}>{stringFrom(account.name, "Account")} · {formatMoney(account.balanceMinor ?? account.currentBalanceMinor, accountCurrency)}</option>; })}
              </Select>
            </Field>
          ) : (
            <Field label="Merchant or source">
              <Input autoFocus value={merchant} onChange={(event) => setMerchant(event.target.value)} placeholder={kind === "income" ? "e.g. Employer" : "e.g. Supermarket"} maxLength={120} />
            </Field>
          )}
          <Field
            label={`${kind === "adjustment" ? "Signed amount" : isForeignEntry ? kind === "expense" ? "Purchase amount" : kind === "income" ? "Income amount" : kind === "refund" ? "Refund amount" : "Original amount" : "Amount"} (${kind === "transfer" ? selectedCurrency : normalizedEnteredCurrency || selectedCurrency})`}
            hint={kind === "adjustment" ? "Use a minus sign to reduce the balance." : "Enter a positive amount."}
          >
            <Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={minorToInput(0, kind === "transfer" ? selectedCurrency : normalizedEnteredCurrency || selectedCurrency)} />
          </Field>
          {kind !== "transfer" ? (
            <Field htmlFor="transaction-entered-currency" label="Entered currency" hint={`Account ledger currency: ${selectedCurrency}`}>
              <CurrencyCombobox
                id="transaction-entered-currency"
                value={enteredCurrency}
                onChange={(value) => {
                  setEnteredCurrency(value);
                  setEnteredCurrencyFollowsAccount(value.toUpperCase() === selectedCurrency);
                }}
                invalid={!enteredCurrencyValid}
              />
            </Field>
          ) : null}
          {isCurrencyConversion ? (
            <div className={`${ui.fxPanel} ${ui.formSpan}`}>
              <div className={ui.fxPanelHeader}>
                <span>
                  <strong>{isCrossCurrencyTransfer ? "Transfer conversion" : "Currency conversion"}</strong>
                  <small>BNR is a reference estimate. Your bank or card statement is the source of truth.</small>
                </span>
                {fxLoading ? <Pill tone="info">Loading BNR rate…</Pill> : fxQuote ? <Pill tone={fxQuote.isFallback ? "warning" : "info"}>BNR reference</Pill> : <Pill tone="warning">Manual rate needed</Pill>}
              </div>
              {fxQuote ? (
                <div className={ui.fxReference}>
                  <strong>1 {conversionFromCurrency} = {formatRate(fxQuote.rateScaled, fxQuote.rateScale)} {conversionToCurrency}</strong>
                  <span>
                    Effective {formatDate(fxQuote.rateDate, { day: "2-digit", month: "short", year: "numeric" })}
                    {fxQuote.isFallback ? ` · previous available BNR day (${fxQuote.fallbackDays} day${fxQuote.fallbackDays === 1 ? "" : "s"} earlier)` : ""}
                  </span>
                </div>
              ) : fxError ? <div className={ui.fxError} role="status">{fxError} Enter a manual exchange rate to continue.</div> : null}
              {fxQuote?.isStale ? (
                <div className={ui.fxError} role="status">Live BNR refresh failed, so this uses the cached official quote dated {formatDate(fxQuote.rateDate, { day: "2-digit", month: "short", year: "numeric" })}. You can keep this reference or enter a manual rate.</div>
              ) : null}
              <div className={ui.fxControls}>
                <Field
                  label={`Exchange rate (${conversionToCurrency} per 1 ${conversionFromCurrency})`}
                  hint={useExactAccountAmount ? "Derived from the exact original and account amounts." : rateMode === "manual" ? "Manual override; BNR reference remains recorded when available." : "BNR reference rate; enable manual editing to override it."}
                >
                  <Input
                    inputMode="decimal"
                    value={displayedRate}
                    disabled={rateMode === "reference" || useExactAccountAmount}
                    onChange={(event) => { setManualRate(event.target.value); setUseExactAccountAmount(false); }}
                    placeholder={fxLoading ? "Loading…" : "e.g. 5.075"}
                  />
                </Field>
                <Field
                  label={`Amount posted to ${conversionTargetAccountName} (${conversionToCurrency})`}
                  hint={useExactAccountAmount
                    ? exactAmountReconciles ? "Exact statement or bank amount; the rate is derived from both amounts." : "This amount cannot reconcile at eight-decimal rate precision. Edit the rate instead."
                    : "Calculated with integer minor-unit rounding."}
                >
                  <Input
                    inputMode="decimal"
                    value={displayedAccountAmount}
                    disabled={!useExactAccountAmount}
                    aria-invalid={useExactAccountAmount && !exactAmountReconciles}
                    onChange={(event) => setExactAccountAmount(event.target.value)}
                    placeholder={fxLoading ? "Calculating…" : minorToInput(0, conversionToCurrency)}
                  />
                </Field>
              </div>
              <div className={ui.fxOptions}>
                <label className={`${ui.small} ${ui.inlineCheck}`}>
                  <input
                    type="checkbox"
                    checked={rateMode === "manual"}
                    onChange={(event) => {
                      if (event.target.checked) {
                        setRateMode("manual");
                        setManualRate(referenceRateScaled ? rateScaledToInput(referenceRateScaled, rateScale) : manualRate);
                      } else {
                        setRateMode("reference");
                        setUseExactAccountAmount(false);
                      }
                    }}
                  /> Edit exchange rate manually
                </label>
                <label className={`${ui.small} ${ui.inlineCheck}`}>
                  <input
                    type="checkbox"
                    checked={useExactAccountAmount}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setUseExactAccountAmount(checked);
                      setRateMode("manual");
                      if (checked) {
                        setExactAccountAmount(calculatedAccountAmountMinor === null ? "" : minorToInput(calculatedAccountAmountMinor, conversionToCurrency));
                      } else if (derivedExactRateScaled) {
                        setManualRate(rateScaledToInput(derivedExactRateScaled, rateScale));
                      }
                    }}
                  /> Use exact {isCrossCurrencyTransfer ? "destination" : "account"} amount
                </label>
              </div>
              {status === "pending" && !useExactAccountAmount ? (
                <p className={ui.fxEstimateNote}>This pending transaction will be saved with an estimated posted amount. Update it from the final statement amount when cleared.</p>
              ) : null}
            </div>
          ) : null}
          {kind !== "transfer" ? (
            <Field
              label="Category"
              hint={useSplits ? "The new category will be assigned to the first empty split row." : inferredCategoryKind ? `Showing ${inferredCategoryKind} and shared categories.` : "Adjustments can use existing categories, but do not create a new spending classification."}
            >
              <div className={ui.categoryPickerRow}>
                <Select
                  searchable
                  searchPlaceholder="Search categories"
                  disabled={useSplits}
                  value={categoryId}
                  onValueChange={setCategoryId}
                >
                  <option value="">Uncategorised</option>
                  {selectableCategories.map((item, index) => { const category = readRecord(item); return <option value={String(category.id)} key={stringFrom(category.id, String(index))}>{categoryPathLabel(item)}</option>; })}
                </Select>
                {inferredCategoryKind ? (
                  <Button
                    className={ui.categoryCreateToggle}
                    variant={categoryCreatorOpen ? "secondary" : "ghost"}
                    icon={<Plus size={15} />}
                    aria-expanded={categoryCreatorOpen}
                    aria-controls="transaction-category-creator"
                    onClick={() => {
                      setCategoryCreatorOpen((current) => !current);
                      setCategoryCreateError(null);
                    }}
                  >
                    Create category
                  </Button>
                ) : null}
              </div>
            </Field>
          ) : null}
          {categoryCreatorOpen && inferredCategoryKind ? (
            <div
              className={`${ui.inlineCategoryCreator} ${ui.formSpan}`}
              id="transaction-category-creator"
              role="group"
              aria-labelledby="transaction-category-creator-title"
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  event.stopPropagation();
                  void createAndSelectCategory();
                }
              }}
            >
              <div className={ui.inlineCategoryHeader}>
                <span>
                  <strong id="transaction-category-creator-title">New {inferredCategoryKind} category</strong>
                  <small>Create it here, keep this transaction open, and select it immediately.</small>
                </span>
                <IconButton label="Close category creator" onClick={resetCategoryCreator}><X size={15} /></IconButton>
              </div>
              <div className={ui.inlineCategoryGrid}>
                <Field label="Category name">
                  <Input
                    autoFocus
                    value={newCategoryName}
                    maxLength={80}
                    onChange={(event) => setNewCategoryName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
                        event.preventDefault();
                        event.stopPropagation();
                        void createAndSelectCategory();
                      }
                    }}
                    placeholder={inferredCategoryKind === "income" ? "e.g. Freelance" : "e.g. Home maintenance"}
                  />
                </Field>
                <Field label="Parent category" hint="Optional; any compatible nesting depth is supported.">
                  <Select searchable searchPlaceholder="Search parent categories" value={newCategoryParentId} onValueChange={setNewCategoryParentId}>
                    <option value="">None — top level</option>
                    {quickCategoryParents.map((item, index) => {
                      const category = readRecord(item);
                      return <option value={stringFrom(category.id)} key={stringFrom(category.id, String(index))}>{categoryPathLabel(item)}</option>;
                    })}
                  </Select>
                </Field>
                {inferredCategoryKind === "expense" ? (
                  <>
                    <Field label="Spending pattern">
                      <Select value={newCategoryNature} onValueChange={(value) => setNewCategoryNature(value as "fixed" | "variable")}>
                        <option value="variable">Variable</option>
                        <option value="fixed">Fixed</option>
                      </Select>
                    </Field>
                    <Field label="Priority">
                      <Select value={newCategoryPriority} onValueChange={(value) => setNewCategoryPriority(value as "essential" | "discretionary")}>
                        <option value="discretionary">Discretionary</option>
                        <option value="essential">Essential</option>
                      </Select>
                    </Field>
                  </>
                ) : null}
              </div>
              <FormMessage error={categoryCreateError} />
              <div className={ui.inlineCategoryActions}>
                <Button variant="ghost" onClick={resetCategoryCreator}>Cancel</Button>
                <Button disabled={creatingCategory || !newCategoryName.trim()} onClick={() => void createAndSelectCategory()}>
                  {creatingCategory ? "Creating…" : useSplits ? "Create and add to split" : "Create and select"}
                </Button>
              </div>
            </div>
          ) : null}
          <Field label="Tags" hint="Comma-separated; new tags are created automatically">
            <Input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="home, work" />
          </Field>
          <Field
            htmlFor="transaction-receipt"
            label="Receipt"
            hint="Optional PDF or image · up to 10 MB · stored privately with this transaction"
          >
            <div className={ui.attachmentUpload}>
              <input
                key={attachmentInputKey}
                className="sr-only"
                id="transaction-receipt"
                type="file"
                accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif,.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif"
                aria-describedby="transaction-receipt-hint"
                onChange={(event) => setAttachmentFile(event.target.files?.[0] ?? null)}
              />
              <label className={`${kit.button} ${kit.button_secondary} ${ui.attachmentPicker}`} htmlFor="transaction-receipt">
                <Paperclip size={15} aria-hidden="true" /> {attachmentFile ? "Replace receipt" : "Choose receipt"}
              </label>
              {attachmentFile ? (
                <span className={ui.attachmentPreview}>
                  <span>
                    <strong>{attachmentFile.name}</strong>
                    <small>{new Intl.NumberFormat(workspaceLocale(), { maximumFractionDigits: 1 }).format(attachmentFile.size / 1024)} KB</small>
                  </span>
                  <IconButton
                    label="Remove selected receipt"
                    onClick={() => {
                      setAttachmentFile(null);
                      setAttachmentInputKey((current) => current + 1);
                    }}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </span>
              ) : initial && numberFrom(initial.attachmentCount) > 0 ? (
                <span className={ui.attachmentLegacyNote}>Existing receipts are not copied to the duplicate.</span>
              ) : null}
            </div>
          </Field>
          <Field label="Notes" className={ui.formSpan}>
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional detail" maxLength={1000} />
          </Field>
        </div>

        {kind !== "transfer" ? (
          <div className={ui.blockOffset}>
            <label className={`${ui.small} ${ui.inlineCheck}`}>
              <input type="checkbox" checked={useSplits} onChange={(event) => setUseSplits(event.target.checked)} /> Split across categories
            </label>
          </div>
        ) : (
          <div className={`${ui.inlineNotice} ${ui.noticeOffset}`}><ArrowLeftRight size={16} />LedgerLab creates linked entries in each account’s own currency. Transfers are excluded from all income and spending totals.</div>
        )}

        {useSplits ? (
          <Section title="Category split" description="Every split uses integer minor units internally" plain>
            <div className={ui.splitList}>
              {splits.map((split, index) => (
                <div className={ui.splitRow} key={index}>
                  <Field label={`Category ${index + 1}`}>
                    <Select searchable searchPlaceholder="Search categories" value={split.categoryId} onValueChange={(value) => setSplits((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, categoryId: value } : item))}>
                      <option value="">Choose category</option>
                      {selectableCategories.map((item, categoryIndex) => { const category = readRecord(item); return <option value={String(category.id)} key={stringFrom(category.id, String(categoryIndex))}>{categoryPathLabel(item)}</option>; })}
                    </Select>
                  </Field>
                  <Field label={`Amount (${selectedCurrency})`}><Input inputMode="decimal" value={split.amount} onChange={(event) => setSplits((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))} /></Field>
                  <IconButton label="Remove split" disabled={splits.length <= 2} onClick={() => setSplits((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={15} /></IconButton>
                </div>
              ))}
              <Button type="button" variant="ghost" icon={<Plus size={14} />} onClick={() => setSplits((current) => [...current, { categoryId: "", amount: "" }])}>Add split</Button>
              <div className={ui.splitTotal}><span>Split total ({selectedCurrency})</span><strong className={splitTotal === (postedAccountAmountAbsolute ?? 0) ? ui.positive : ui.warning}>{formatMoney(splitTotal, selectedCurrency)} / {postedAccountAmountAbsolute === null ? "—" : formatMoney(postedAccountAmountAbsolute, selectedCurrency)}</strong></div>
            </div>
          </Section>
        ) : null}

        {duplicateDetected ? (
          <div className={`${ui.inlineNotice} ${ui.inlineNoticeWarning} ${ui.noticeOffset}`}>
            <ReceiptText size={16} />
            <label>
              <input type="checkbox" checked={duplicateConfirmed} onChange={(event) => setConfirmedDuplicateKey(event.target.checked ? duplicateKey : null)} />
              I reviewed this possible duplicate and want to save it again.
            </label>
          </div>
        ) : null}
        <FormMessage error={submitError} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
