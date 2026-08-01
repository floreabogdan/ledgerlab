"use client";

import {
  Archive,
  BadgeDollarSign,
  Banknote,
  ChevronDown,
  CreditCard,
  Ellipsis,
  Landmark,
  LineChart,
  PiggyBank,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useDateRange } from "@/components/date-range-context";
import { CurrencyCombobox } from "@/components/ui/currency-combobox";
import { DEFAULT_CURRENCY, isSupportedCurrency } from "@/lib/currencies";
import {
  LOAN_INTERVAL_MONTH_SUGGESTIONS,
  LOAN_REFERENCE_INDEX_SUGGESTIONS,
} from "@/lib/loan-options";
import {
  AddButton,
  Button,
  DataState,
  Field,
  FormMessage,
  formatDate,
  formatMoney,
  IconButton,
  Input,
  isoToday,
  Metric,
  Modal,
  moneyInputToMinor,
  minorToInput,
  numberFrom,
  Page,
  Pill,
  readList,
  readRecord,
  requestJson,
  Section,
  Select,
  SparkBars,
  stringFrom,
  SuggestionInput,
  Tabs,
  Toggle,
  useJson,
  useSubmit,
  ViewHeader,
} from "../_components/feature-kit";
import ui from "../_components/pages.module.css";

type Account = Record<string, unknown>;
type AccountFilter = "active" | "archived" | "all";

const accountTypes = [
  ["current_account", "Current account"],
  ["savings", "Savings"],
  ["cash", "Cash"],
  ["credit_card", "Credit card"],
  ["loan", "Loan"],
  ["investment", "Investment"],
  ["custom", "Custom"],
] as const;

const liabilityTypes = new Set(["credit_card", "loan"]);

function addMonths(date: string, count: number) {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + count, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function percentInputToBps(value: string, label: string, optional = false, allowNegative = false) {
  if (optional && !value.trim()) return null;
  const normalized = value.trim().replace(",", ".");
  if (!/^-?\d+(?:\.\d{0,2})?$/.test(normalized)) {
    throw new Error(`Enter a valid ${label} with no more than two decimal places.`);
  }
  const parsed = Number(normalized);
  if ((!allowNegative && parsed < 0) || parsed < -1_000 || parsed > 10_000) throw new Error(`Enter a valid ${label}.`);
  return Math.round(parsed * 100);
}

function optionalMoneyInputToMinor(value: string, label: string, currency: string) {
  if (!value.trim()) return null;
  const result = moneyInputToMinor(value, currency);
  if (result === null || result < 0) throw new Error(`Enter a valid ${label} for ${currency}.`);
  return result;
}

function optionalInteger(value: string, label: string, minimum: number, maximum: number) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Enter a valid ${label}.`);
  return parsed;
}

function accountIcon(type: string) {
  if (type === "savings") return <PiggyBank size={18} />;
  if (type === "cash") return <Banknote size={18} />;
  if (type === "credit_card") return <CreditCard size={18} />;
  if (type === "loan") return <BadgeDollarSign size={18} />;
  if (type === "investment") return <TrendingUp size={18} />;
  if (type === "current_account" || type === "current") return <Landmark size={18} />;
  return <Wallet size={18} />;
}

export default function AccountsPage() {
  const router = useRouter();
  const { range, label: rangeLabel } = useDateRange();
  const accountsUrl = useMemo(() => {
    const params = new URLSearchParams({ from: range.from, to: range.to });
    return `/api/accounts?${params.toString()}`;
  }, [range.from, range.to]);
  const { data: raw, loading, error, reload } = useJson<Record<string, unknown>>(accountsUrl, {});
  const accounts = readList<Account>(raw, "accounts");
  const workspaceCurrency = stringFrom(readRecord(raw).defaultCurrency, DEFAULT_CURRENCY).toUpperCase();
  const [filter, setFilter] = useState<AccountFilter>("active");
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Account | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("new") === "1") {
      queueMicrotask(() => setCreateOpen(true));
    }
  }, []);

  const activeAccounts = accounts.filter((account) => !Boolean(readRecord(account).archivedAt ?? readRecord(account).isArchived));
  const archivedAccounts = accounts.filter((account) => Boolean(readRecord(account).archivedAt ?? readRecord(account).isArchived));
  const visibleAccounts = filter === "active" ? activeAccounts : filter === "archived" ? archivedAccounts : accounts;
  const assets = activeAccounts.reduce((sum, item) => {
    const account = readRecord(item);
    const balance = numberFrom(account.reportingBalanceMinor ?? account.balanceMinor ?? account.currentBalanceMinor);
    return sum + (liabilityTypes.has(stringFrom(account.type)) ? Math.max(0, balance) : balance);
  }, 0);
  const liabilities = activeAccounts.reduce((sum, item) => {
    const account = readRecord(item);
    const balance = numberFrom(account.reportingBalanceMinor ?? account.balanceMinor ?? account.currentBalanceMinor);
    return sum + (liabilityTypes.has(stringFrom(account.type)) ? Math.max(0, -balance) : 0);
  }, 0);
  const total = assets - liabilities;

  async function archiveAccount(account: Account) {
    const record = readRecord(account);
    const archived = Boolean(record.archivedAt ?? record.isArchived);
    setActionError(null);
    try {
      await requestJson("/api/accounts", {
        method: "POST",
        body: JSON.stringify({ action: archived ? "restore" : "archive", id: record.id }),
      });
      if (selected && selected.id === record.id) setSelected(null);
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not update account");
    }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow="Money locations"
        title="Accounts"
        description="Opening balances and actual transactions reconcile into each current balance. Archiving keeps every historical record intact."
        actions={<AddButton onClick={() => setCreateOpen(true)}>Add account</AddButton>}
      />

      <div className={ui.metricGrid}>
        <Metric label="Net account value" value={formatMoney(total, workspaceCurrency)} tone={total >= 0 ? "accent" : "negative"} info={`Active account balances translated to ${workspaceCurrency} at the latest available as-of rates. Native balances are never rewritten.`} />
        <Metric label="Assets" value={formatMoney(assets, workspaceCurrency)} detail={`${activeAccounts.filter((item) => !liabilityTypes.has(stringFrom(readRecord(item).type))).length} active asset accounts`} info={`Cross-account total in your ${workspaceCurrency} reporting currency.`} />
        <Metric label="Debt outstanding" value={formatMoney(liabilities, workspaceCurrency)} tone={liabilities > 0 ? "warning" : "default"} info={`Amounts currently owed, translated to ${workspaceCurrency}; overpayments are not counted as debt.`} />
        <Metric label="Archived" value={archivedAccounts.length} detail="History remains available" />
      </div>

      <Section
        title="Your accounts"
        description="Balances shown are actual and exclude unpaid planned payments"
        action={
          <Tabs
            id="account-visibility"
            panelId="account-visibility-panel"
            label="Account visibility"
            value={filter}
            onChange={setFilter}
            items={[
              { value: "active", label: "Active", count: activeAccounts.length },
              { value: "archived", label: "Archived", count: archivedAccounts.length },
              { value: "all", label: "All", count: accounts.length },
            ]}
          />
        }
        plain
      >
        <div id="account-visibility-panel" role="tabpanel" aria-labelledby={`account-visibility-${filter}-tab`}>
          <FormMessage error={actionError} />
          <DataState
            loading={loading}
            error={error}
            onRetry={reload}
            empty={!visibleAccounts.length}
            emptyTitle={filter === "archived" ? "No archived accounts" : "Create your first account"}
            emptyDescription={filter === "archived" ? "Accounts you archive will appear here with all history preserved." : "Start with the account you use most. Its opening balance becomes the reconciliation baseline."}
            action={filter !== "archived" ? <AddButton onClick={() => setCreateOpen(true)}>Add account</AddButton> : undefined}
          >
            <div className={ui.accountGrid}>
            {visibleAccounts.map((item, index) => {
              const account = readRecord(item);
              const archived = Boolean(account.archivedAt ?? account.isArchived);
              const type = stringFrom(account.type, "custom");
              const balance = numberFrom(account.balanceMinor ?? account.currentBalanceMinor);
              const currency = stringFrom(account.currency, DEFAULT_CURRENCY);
              const isLiability = liabilityTypes.has(type);
              const debt = Math.max(0, -balance);
              const creditMetrics = readRecord(account.creditMetrics);
              const loanMetrics = readRecord(account.loanMetrics);
              const utilizationBps = numberFrom(creditMetrics.utilizationBps, -1);
              const originalPrincipal = numberFrom(loanMetrics.originalPrincipalMinor);
              const repaidPrincipal = numberFrom(loanMetrics.principalRepaidMinor);
              const repaymentPercent = originalPrincipal > 0 ? Math.min(100, Math.max(0, (repaidPrincipal / originalPrincipal) * 100)) : 0;
              const openDetails = () => {
                if (isLiability) router.push(`/accounts/${stringFrom(account.id)}`);
                else setSelected(account);
              };
              return (
                <article
                  className={`${ui.accountCard} ${archived ? ui.accountCardArchived : ""}`}
                  style={{ "--account-color": stringFrom(account.color, "#2563eb") } as React.CSSProperties}
                  key={stringFrom(account.id, String(index))}
                >
                  <div className={ui.accountCardHeader}>
                    <div className={ui.accountTitle}>
                      <span aria-hidden="true">{accountIcon(type)}</span>
                      <span>
                        <strong>{stringFrom(account.name, "Unnamed account")}</strong>
                        <small>{stringFrom(account.customType ?? account.customTypeLabel, type).replaceAll("_", " ")} · {currency}{account.institution ? ` · ${stringFrom(account.institution)}` : ""}</small>
                      </span>
                    </div>
                    {archived ? <Pill>archived</Pill> : <IconButton label={isLiability ? "Manage debt" : "Account details"} onClick={openDetails}><Ellipsis size={18} /></IconButton>}
                  </div>
                  <span className={ui.accountBalanceLabel}>{isLiability ? (balance > 0 ? "Credit balance" : "Outstanding") : "Current balance"}</span>
                  <strong className={`${ui.accountBalance} ${debt > 0 ? ui.negative : ""}`}>{formatMoney(isLiability ? (balance > 0 ? balance : debt) : balance, currency)}</strong>
                  {type === "credit_card" && Object.keys(creditMetrics).length ? (
                    <div className={ui.liabilitySnapshot}>
                      <div className={ui.liabilityProgress} aria-label={utilizationBps >= 0 ? `Credit utilization ${(utilizationBps / 100).toFixed(1)} percent` : "Credit utilization unavailable"}>
                        <span style={{ width: `${utilizationBps < 0 ? 0 : Math.min(100, utilizationBps / 100)}%` }} />
                      </div>
                      <div className={ui.liabilityFacts}>
                        <span>Available <strong>{formatMoney(creditMetrics.availableCreditMinor, currency)}</strong></span>
                        <span>{utilizationBps >= 0 ? `${(utilizationBps / 100).toFixed(1)}% used` : "No limit set"}</span>
                      </div>
                    </div>
                  ) : null}
                  {type === "loan" && Object.keys(loanMetrics).length ? (
                    <div className={ui.liabilitySnapshot}>
                      <div className={`${ui.liabilityProgress} ${ui.loanProgress}`} aria-label={`${repaymentPercent.toFixed(1)} percent of scheduled principal repaid`}>
                        <span style={{ width: `${repaymentPercent}%` }} />
                      </div>
                      <div className={ui.liabilityFacts}>
                        <span>Original <strong>{formatMoney(originalPrincipal, currency)}</strong></span>
                        <span>{repaymentPercent.toFixed(1)}% repaid</span>
                      </div>
                    </div>
                  ) : null}
                  <div className={ui.accountMeta}>
                    <span>{isLiability ? "Opening debt" : "Opening"} {formatMoney(isLiability ? Math.max(0, -numberFrom(account.openingBalanceMinor)) : account.openingBalanceMinor, currency)}</span>
                    <span>as of {formatDate(account.openingDate ?? account.openingBalanceDate ?? account.createdAt, { day: "2-digit", month: "short", year: undefined })}</span>
                  </div>
                  <div className={ui.accountActions}>
                    <Button variant="ghost" onClick={openDetails}>{isLiability ? "Manage debt" : "Balance history"}</Button>
                    <Button variant="ghost" onClick={() => void archiveAccount(account)}>{archived ? "Restore" : "Archive"}</Button>
                  </div>
                </article>
              );
            })}
            </div>
          </DataState>
        </div>
      </Section>

      <AccountForm key={`${createOpen ? "account-form-open" : "account-form-closed"}-${workspaceCurrency}`} open={createOpen} sourceAccounts={activeAccounts} defaultCurrency={workspaceCurrency} onClose={() => setCreateOpen(false)} onCreated={reload} />
      <AccountDetail account={selected} rangeLabel={rangeLabel} onClose={() => setSelected(null)} onArchive={archiveAccount} />
    </Page>
  );
}

type AccountFormDraft = {
  name: string;
  type: string;
  customTypeLabel: string;
  currency: string;
  institution: string;
  openingBalance: string;
  openingDate: string;
  color: string;
  cardLimit: string;
  cardOpeningMode: "outstanding" | "available";
  cardOpeningAmount: string;
  cardStatementDay: string;
  cardDueDay: string;
  cardGraceDays: string;
  cardApr: string;
  cardMinimumMode: "manual" | "percentage" | "fixed";
  cardMinimumRate: string;
  cardMinimumFixed: string;
  cardPaymentPreference: "full_statement" | "minimum" | "custom";
  generatePlannedPayments: boolean;
  loanOutstanding: string;
  loanOriginalPrincipal: string;
  loanOriginationDate: string;
  loanFirstPaymentDate: string;
  loanMaturityDate: string;
  loanPaymentAccountId: string;
  loanPaymentFrequency: "monthly" | "quarterly" | "yearly" | "custom";
  loanPaymentIntervalMonths: string;
  loanTermMonths: string;
  loanAmortization: "annuity" | "equal_principal" | "interest_only";
  loanJurisdiction: string;
  loanRateType: "fixed" | "variable";
  loanFixedRate: string;
  loanReferenceIndex: string;
  loanReferenceTenorMonths: string;
  loanReferenceRate: string;
  loanMargin: string;
  loanResetFrequencyMonths: string;
  loanNextResetDate: string;
  loanObservationLagMonths: string;
  loanFloorRate: string;
  loanCapRate: string;
};

function initialAccountDraft(defaultCurrency = DEFAULT_CURRENCY): AccountFormDraft {
  const today = isoToday();
  const zero = minorToInput(0, defaultCurrency);
  return {
    name: "", type: "current_account", customTypeLabel: "", currency: defaultCurrency, institution: "",
    openingBalance: zero, openingDate: today, color: "#2563eb",
    cardLimit: "", cardOpeningMode: "outstanding", cardOpeningAmount: zero,
    cardStatementDay: "", cardDueDay: "", cardGraceDays: "", cardApr: "",
    cardMinimumMode: "manual", cardMinimumRate: "", cardMinimumFixed: "",
    cardPaymentPreference: "full_statement", generatePlannedPayments: true,
    loanOutstanding: "", loanOriginalPrincipal: "", loanOriginationDate: today,
    loanFirstPaymentDate: addMonths(today, 1), loanMaturityDate: "", loanPaymentAccountId: "",
    loanPaymentFrequency: "monthly", loanPaymentIntervalMonths: "1", loanTermMonths: "60",
    loanAmortization: "annuity", loanJurisdiction: "", loanRateType: "fixed", loanFixedRate: "5.00",
    loanReferenceIndex: "", loanReferenceTenorMonths: "3", loanReferenceRate: "",
    loanMargin: "0.00", loanResetFrequencyMonths: "3", loanNextResetDate: "",
    loanObservationLagMonths: "0", loanFloorRate: "", loanCapRate: "",
  };
}

function AccountForm({
  open,
  sourceAccounts,
  defaultCurrency,
  onClose,
  onCreated,
}: {
  open: boolean;
  sourceAccounts: Account[];
  defaultCurrency: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [form, setForm] = useState<AccountFormDraft>(() => initialAccountDraft(defaultCurrency));
  const today = isoToday();
  const setValue = <Key extends keyof AccountFormDraft>(key: Key, value: AccountFormDraft[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const currency = form.currency.trim().toUpperCase();
  const availableSourceAccounts = sourceAccounts.filter((item) => {
    const account = readRecord(item);
    return new Set(["current", "current_account", "savings", "cash"]).has(stringFrom(account.type)) && !account.archivedAt;
  });
  const previewLimit = Math.max(0, moneyInputToMinor(form.cardLimit, currency) ?? 0);
  const previewCardAmount = Math.max(0, moneyInputToMinor(form.cardOpeningAmount, currency) ?? 0);
  const previewOutstanding = form.cardOpeningMode === "available" ? Math.max(0, previewLimit - previewCardAmount) : previewCardAmount;
  const isLiability = liabilityTypes.has(form.type);

  const { submit, submitting, submitError, setSubmitError } = useSubmit(async () => {
    if (!form.name.trim()) throw new Error("Enter an account name.");
    if (!isSupportedCurrency(currency)) throw new Error("Choose a supported ISO 4217 currency.");
    if (!form.openingDate) throw new Error("Choose the balance date.");
    if (form.type === "custom" && !form.customTypeLabel.trim()) throw new Error("Describe the custom account type.");

    let openingBalanceMinor = moneyInputToMinor(form.openingBalance, currency);
    let creditLimitMinor: number | null = null;
    let creditCard: Record<string, unknown> | undefined;
    let loan: Record<string, unknown> | undefined;

    if (form.type === "credit_card") {
      const limit = moneyInputToMinor(form.cardLimit, currency);
      const enteredAmount = moneyInputToMinor(form.cardOpeningAmount, currency);
      if (limit === null || limit <= 0) throw new Error("Enter a positive credit limit.");
      if (enteredAmount === null || enteredAmount < 0) throw new Error("Enter a valid opening card amount.");
      if (form.cardOpeningMode === "available" && enteredAmount > limit) throw new Error("Opening available credit cannot exceed the card limit.");
      const outstanding = form.cardOpeningMode === "available" ? limit - enteredAmount : enteredAmount;
      openingBalanceMinor = -outstanding;
      creditLimitMinor = limit;
      const minimumPaymentRateBps = form.cardMinimumMode === "percentage"
        ? percentInputToBps(form.cardMinimumRate, "minimum payment percentage")
        : null;
      const minimumPaymentFixedMinor = form.cardMinimumMode === "fixed"
        ? optionalMoneyInputToMinor(form.cardMinimumFixed, "fixed minimum payment", currency)
        : null;
      if (form.cardMinimumMode === "fixed" && minimumPaymentFixedMinor === null) throw new Error("Enter the fixed minimum payment.");
      creditCard = {
        creditLimitMinor: limit,
        statementDay: optionalInteger(form.cardStatementDay, "statement day", 1, 31),
        dueDay: optionalInteger(form.cardDueDay, "payment due day", 1, 31),
        gracePeriodDays: optionalInteger(form.cardGraceDays, "grace period", 0, 180),
        purchaseAprBps: percentInputToBps(form.cardApr, "purchase APR", true),
        minimumPaymentMode: form.cardMinimumMode,
        minimumPaymentRateBps,
        minimumPaymentFixedMinor,
        paymentPreference: form.cardPaymentPreference,
        generatePlannedPayments: form.generatePlannedPayments,
      };
    } else if (form.type === "loan") {
      const outstanding = moneyInputToMinor(form.loanOutstanding, currency);
      if (outstanding === null || outstanding <= 0) throw new Error("Enter the loan principal currently outstanding.");
      const originalPrincipal = optionalMoneyInputToMinor(form.loanOriginalPrincipal, "original principal", currency) ?? outstanding;
      if (originalPrincipal <= 0) throw new Error("Original principal must be positive.");
      const termMonths = optionalInteger(form.loanTermMonths, "loan term in months", 1, 1200);
      const paymentIntervalMonths = optionalInteger(form.loanPaymentIntervalMonths, "payment interval", 1, 120);
      if (termMonths === null || paymentIntervalMonths === null) throw new Error("Enter the loan term and payment interval.");
      if (!form.loanOriginationDate || !form.loanFirstPaymentDate) throw new Error("Choose the origination and first payment dates.");
      openingBalanceMinor = -outstanding;
      const rate = form.loanRateType === "fixed"
        ? {
            rateType: "fixed",
            effectiveFrom: form.loanOriginationDate,
            effectiveTo: null,
            fixedRateBps: percentInputToBps(form.loanFixedRate, "fixed annual interest rate"),
          }
        : {
            rateType: "variable",
            effectiveFrom: form.loanOriginationDate,
            effectiveTo: null,
            referenceIndex: form.loanReferenceIndex.trim(),
            referenceTenorMonths: optionalInteger(form.loanReferenceTenorMonths, "reference index tenor", 1, 120),
            referenceRateBps: percentInputToBps(form.loanReferenceRate, "reference index rate", false, true),
            marginBps: percentInputToBps(form.loanMargin, "lender margin", false, true),
            resetFrequencyMonths: optionalInteger(form.loanResetFrequencyMonths, "rate reset frequency", 1, 120),
            nextResetDate: form.loanNextResetDate || null,
            observationLagMonths: optionalInteger(form.loanObservationLagMonths, "observation lag", 0, 120) ?? 0,
            floorRateBps: percentInputToBps(form.loanFloorRate, "rate floor", true, true),
            capRateBps: percentInputToBps(form.loanCapRate, "rate cap", true, true),
          };
      if (form.loanRateType === "variable" && !form.loanReferenceIndex.trim()) throw new Error("Enter the reference index name.");
      if (form.loanRateType === "variable" && (rate.referenceTenorMonths === null || rate.resetFrequencyMonths === null)) {
        throw new Error("Enter the index tenor and reset frequency.");
      }
      loan = {
        originalPrincipalMinor: originalPrincipal,
        originationDate: form.loanOriginationDate,
        firstPaymentDate: form.loanFirstPaymentDate,
        maturityDate: form.loanMaturityDate || null,
        paymentAccountId: form.loanPaymentAccountId || null,
        paymentFrequency: form.loanPaymentFrequency,
        paymentIntervalMonths,
        termMonths,
        amortizationMethod: form.loanAmortization,
        jurisdictionCode: form.loanJurisdiction.trim().toUpperCase() || null,
        interestCategoryId: null,
        feeCategoryId: null,
        generatePlannedPayments: form.generatePlannedPayments,
        rate,
      };
    }

    if (openingBalanceMinor === null) throw new Error(`Enter a valid opening balance for ${currency}.`);
    await requestJson("/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        name: form.name.trim(),
        type: form.type,
        customTypeLabel: form.type === "custom" ? form.customTypeLabel.trim() : null,
        currency,
        institution: form.institution.trim() || null,
        openingBalanceMinor,
        openingDate: form.openingDate,
        creditLimitMinor,
        color: form.color,
        creditCard,
        loan,
      }),
    });
    onClose();
    await onCreated();
  });

  const accountLabel = form.type === "credit_card" ? "Credit card name" : form.type === "loan" ? "Loan name" : "Account name";
  const formDescription = form.type === "credit_card"
    ? "Enter the limit and either what you owe or what is still available. LedgerLab derives the signed opening debt for you."
    : form.type === "loan"
      ? "Loan principal is stored as a liability. The generated schedule keeps principal transfers separate from interest and fees."
      : "The opening balance establishes the account’s actual starting point.";

  return (
    <Modal
      open={open}
      size={isLiability ? "xl" : "lg"}
      onClose={() => { setSubmitError(null); onClose(); }}
      title="Add account"
      description={formDescription}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={submitting} onClick={() => void submit()}>{submitting ? "Creating…" : "Create account"}</Button>
        </>
      }
    >
      <form
        className={`${ui.formGrid} ${isLiability ? ui.accountLiabilityFormGrid : ""}`}
        onSubmit={(event) => void submit(event)}
      >
        <Field label={accountLabel} className={ui.formSpan}>
          <Input autoFocus value={form.name} onChange={(event) => setValue("name", event.target.value)} placeholder={form.type === "loan" ? "e.g. Home mortgage" : form.type === "credit_card" ? "e.g. Everyday Visa" : "e.g. Main current account"} maxLength={80} />
        </Field>
        <Field label="Account type">
          <Select value={form.type} onValueChange={(value) => setValue("type", value)}>
            {accountTypes.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </Select>
        </Field>
        <Field
          htmlFor="account-currency"
          label="Currency"
          hint={`Immutable ledger currency · defaults to ${defaultCurrency}. Cross-currency totals require BNR coverage.`}
        >
          <CurrencyCombobox
            id="account-currency"
            value={form.currency}
            invalid={!isSupportedCurrency(currency)}
            onChange={(value) => {
              setForm((current) => ({
                ...current,
                currency: value,
                openingBalance: moneyInputToMinor(current.openingBalance, current.currency) === 0
                  ? minorToInput(0, value)
                  : current.openingBalance,
                cardOpeningAmount: moneyInputToMinor(current.cardOpeningAmount, current.currency) === 0
                  ? minorToInput(0, value)
                  : current.cardOpeningAmount,
              }));
            }}
          />
        </Field>
        <Field label="Institution" hint="Optional bank or lender">
          <Input value={form.institution} onChange={(event) => setValue("institution", event.target.value)} placeholder="e.g. Your bank" maxLength={120} />
        </Field>
        <Field label="Balance date">
          <Input type="date" max={today} value={form.openingDate} onChange={(event) => setValue("openingDate", event.target.value)} />
        </Field>
        {form.type === "custom" ? (
          <Field label="Custom type" className={ui.formSpan}>
            <Input value={form.customTypeLabel} onChange={(event) => setValue("customTypeLabel", event.target.value)} placeholder="e.g. Employee benefit card" maxLength={60} />
          </Field>
        ) : null}

        {form.type === "credit_card" ? (
          <>
            <div className={`${ui.formSectionTitle} ${ui.formSpan}`}><strong>Credit position</strong><span>The credit limit is capacity, not money you own.</span></div>
            <Field label={`Credit limit (${currency || "currency"})`} hint="Enter a positive limit">
              <Input inputMode="decimal" value={form.cardLimit} onChange={(event) => setValue("cardLimit", event.target.value)} placeholder="5000" />
            </Field>
            <Field label="Opening amount represents">
              <Select value={form.cardOpeningMode} onValueChange={(value) => setValue("cardOpeningMode", value as AccountFormDraft["cardOpeningMode"])}>
                <option value="outstanding">Amount already used / owed</option>
                <option value="available">Credit still available</option>
              </Select>
            </Field>
            <Field label={`${form.cardOpeningMode === "outstanding" ? "Outstanding debt" : "Available credit"} (${currency || "currency"})`}>
              <Input inputMode="decimal" value={form.cardOpeningAmount} onChange={(event) => setValue("cardOpeningAmount", event.target.value)} />
            </Field>
            <div className={`${ui.derivedValue} ${ui.accountDerivedValue} ${ui.formSpan}`} aria-live="polite">
              <span>Opening debt LedgerLab will record</span>
              <strong>{formatMoney(previewOutstanding, currency || DEFAULT_CURRENCY)}</strong>
            </div>
            <details className={`${ui.formDisclosure} ${ui.formSpan}`}>
              <summary className={ui.formDisclosureSummary} aria-label="Advanced card setup">
                <span>
                  <strong>Advanced card setup</strong>
                  <small>Statement dates, APR and the issuer&apos;s minimum-payment rule</small>
                </span>
                <ChevronDown size={18} aria-hidden="true" />
              </summary>
              <div className={ui.formDisclosureBody}>
                <div className={`${ui.formGrid} ${ui.accountAdvancedGrid}`}>
                <Field label="Usual statement day (reference)" hint="Day of month, 1–31">
                  <Input type="number" min={1} max={31} value={form.cardStatementDay} onChange={(event) => setValue("cardStatementDay", event.target.value)} placeholder="e.g. 15" />
                </Field>
                <Field label="Usual payment due day (reference)" hint="Day of month, if fixed">
                  <Input type="number" min={1} max={31} value={form.cardDueDay} onChange={(event) => setValue("cardDueDay", event.target.value)} placeholder="e.g. 5" />
                </Field>
                <Field label="Grace period (reference)" hint="Optional issuer rule in days">
                  <Input type="number" min={0} max={180} value={form.cardGraceDays} onChange={(event) => setValue("cardGraceDays", event.target.value)} />
                </Field>
                <Field label="Purchase APR (reference, %)" hint="Stored contract rate; statement interest is entered from the lender">
                  <Input inputMode="decimal" value={form.cardApr} onChange={(event) => setValue("cardApr", event.target.value)} placeholder="e.g. 24.99" />
                </Field>
                <Field label="Contract minimum rule (reference)">
                  <Select value={form.cardMinimumMode} onValueChange={(value) => setValue("cardMinimumMode", value as AccountFormDraft["cardMinimumMode"])}>
                    <option value="manual">Enter on each statement</option>
                    <option value="percentage">Percentage of statement</option>
                    <option value="fixed">Fixed amount</option>
                  </Select>
                </Field>
                {form.cardMinimumMode === "percentage" ? (
                  <Field label="Minimum payment (%)">
                    <Input inputMode="decimal" value={form.cardMinimumRate} onChange={(event) => setValue("cardMinimumRate", event.target.value)} placeholder="e.g. 5" />
                  </Field>
                ) : form.cardMinimumMode === "fixed" ? (
                  <Field label={`Fixed minimum (${currency || "currency"})`}>
                    <Input inputMode="decimal" value={form.cardMinimumFixed} onChange={(event) => setValue("cardMinimumFixed", event.target.value)} />
                  </Field>
                ) : <div />}
                <Field label="Default payment plan" className={ui.formSpan}>
                  <Select value={form.cardPaymentPreference} onValueChange={(value) => setValue("cardPaymentPreference", value as AccountFormDraft["cardPaymentPreference"])}>
                    <option value="full_statement">Full statement balance</option>
                    <option value="minimum">Minimum amount due</option>
                    <option value="custom">Custom amount</option>
                  </Select>
                </Field>
                </div>
              </div>
            </details>
          </>
        ) : form.type === "loan" ? (
          <>
            <div className={`${ui.formSectionTitle} ${ui.formSpan}`}><strong>Loan position</strong><span>Enter positive amounts; LedgerLab stores the outstanding principal as negative liability value.</span></div>
            <Field label={`Principal outstanding (${currency || "currency"})`} hint="What you owe on the balance date">
              <Input inputMode="decimal" value={form.loanOutstanding} onChange={(event) => setValue("loanOutstanding", event.target.value)} placeholder="e.g. 250000" />
            </Field>
            <Field label={`Original / schedule principal (${currency || "currency"})`} hint="Optional; defaults to outstanding">
              <Input inputMode="decimal" value={form.loanOriginalPrincipal} onChange={(event) => setValue("loanOriginalPrincipal", event.target.value)} />
            </Field>
            <Field label="Origination date">
              <Input type="date" max={today} value={form.loanOriginationDate} onChange={(event) => setValue("loanOriginationDate", event.target.value)} />
            </Field>
            <Field label="First payment date">
              <Input type="date" value={form.loanFirstPaymentDate} onChange={(event) => setValue("loanFirstPaymentDate", event.target.value)} />
            </Field>
            <Field label="Term (months)" hint="Remaining schedule duration">
              <Input type="number" min={1} max={1200} value={form.loanTermMonths} onChange={(event) => setValue("loanTermMonths", event.target.value)} />
            </Field>
            <Field label="Payment cadence">
              <Select value={form.loanPaymentFrequency} onValueChange={(value) => {
                const frequency = value as AccountFormDraft["loanPaymentFrequency"];
                setForm((current) => ({ ...current, loanPaymentFrequency: frequency, loanPaymentIntervalMonths: frequency === "monthly" ? "1" : frequency === "quarterly" ? "3" : frequency === "yearly" ? "12" : current.loanPaymentIntervalMonths }));
              }}>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="yearly">Yearly</option>
                <option value="custom">Custom interval</option>
              </Select>
            </Field>
            <Field label="Rate type">
              <Select value={form.loanRateType} onValueChange={(value) => setValue("loanRateType", value as AccountFormDraft["loanRateType"])}>
                <option value="fixed">Fixed</option>
                <option value="variable">Variable / indexed</option>
              </Select>
            </Field>
            {form.loanRateType === "fixed" ? (
              <Field label="Annual interest rate (%)">
                <Input inputMode="decimal" value={form.loanFixedRate} onChange={(event) => setValue("loanFixedRate", event.target.value)} />
              </Field>
            ) : (
              <>
                <Field label="Reference index" hint="Free text; jurisdiction-neutral">
                  <SuggestionInput
                    value={form.loanReferenceIndex}
                    suggestions={LOAN_REFERENCE_INDEX_SUGGESTIONS}
                    onValueChange={(value) => setValue("loanReferenceIndex", value)}
                    placeholder="e.g. IRCC, EURIBOR, SOFR"
                    maxLength={80}
                  />
                </Field>
                <Field label="Current index rate (%)">
                  <Input inputMode="decimal" value={form.loanReferenceRate} onChange={(event) => setValue("loanReferenceRate", event.target.value)} placeholder="e.g. 5.55" />
                </Field>
                <Field label="Lender margin (%)">
                  <Input inputMode="decimal" value={form.loanMargin} onChange={(event) => setValue("loanMargin", event.target.value)} placeholder="e.g. 2.10" />
                </Field>
              </>
            )}
            <details className={`${ui.formDisclosure} ${ui.formSpan}`}>
              <summary className={ui.formDisclosureSummary} aria-label="Advanced loan setup">
                <span>
                  <strong>Advanced loan setup</strong>
                  <small>Interest-rate mechanics, schedule method and lender references</small>
                </span>
                <ChevronDown size={18} aria-hidden="true" />
              </summary>
              <div className={ui.formDisclosureBody}>
                <div className={`${ui.formGrid} ${ui.accountAdvancedGrid}`}>
                  <Field label="Contract maturity (reference)" hint="Optional lender date; the estimate uses term and cadence">
                    <Input type="date" value={form.loanMaturityDate} onChange={(event) => setValue("loanMaturityDate", event.target.value)} />
                  </Field>
                  <Field label="Every (months)" hint={form.loanPaymentFrequency === "custom" ? "Custom payment interval" : "Derived from cadence"}>
                    <Input type="number" min={1} max={120} disabled={form.loanPaymentFrequency !== "custom"} value={form.loanPaymentIntervalMonths} onChange={(event) => setValue("loanPaymentIntervalMonths", event.target.value)} />
                  </Field>
            <Field label="Amortization method">
              <Select value={form.loanAmortization} onValueChange={(value) => setValue("loanAmortization", value as AccountFormDraft["loanAmortization"])}>
                <option value="annuity">Annuity / equal total payments</option>
                <option value="equal_principal">Equal principal</option>
                <option value="interest_only">Interest only</option>
              </Select>
            </Field>
            <Field label="Payment account" hint={availableSourceAccounts.length ? "Optional default for installments; conversion is requested when currencies differ" : "No active cash account available"}>
              <Select value={form.loanPaymentAccountId} onValueChange={(value) => setValue("loanPaymentAccountId", value)}>
                <option value="">Choose when paying</option>
                {availableSourceAccounts.map((item) => {
                  const account = readRecord(item);
                  return <option value={stringFrom(account.id)} key={stringFrom(account.id)}>{stringFrom(account.name)} · {stringFrom(account.currency, DEFAULT_CURRENCY)}</option>;
                })}
              </Select>
            </Field>
                {form.loanRateType === "variable" ? (
                  <>
                    <Field label="Index tenor (months)" hint="Common values: 1, 3, 6, 12">
                      <SuggestionInput
                        value={form.loanReferenceTenorMonths}
                        suggestions={LOAN_INTERVAL_MONTH_SUGGESTIONS}
                        onValueChange={(value) => setValue("loanReferenceTenorMonths", value)}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={3}
                      />
                    </Field>
                    <Field label="Rate resets every (months)">
                      <SuggestionInput
                        value={form.loanResetFrequencyMonths}
                        suggestions={LOAN_INTERVAL_MONTH_SUGGESTIONS}
                        onValueChange={(value) => setValue("loanResetFrequencyMonths", value)}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={3}
                      />
                    </Field>
                    <Field label="Next reset date" hint="Optional">
                      <Input type="date" value={form.loanNextResetDate} onChange={(event) => setValue("loanNextResetDate", event.target.value)} />
                    </Field>
                    <Field label="Observation lag (months)" hint="Optional index publication lag">
                      <Input type="number" min={0} max={120} value={form.loanObservationLagMonths} onChange={(event) => setValue("loanObservationLagMonths", event.target.value)} />
                    </Field>
                    <Field label="Rate floor (%)" hint="Optional">
                      <Input inputMode="decimal" value={form.loanFloorRate} onChange={(event) => setValue("loanFloorRate", event.target.value)} />
                    </Field>
                    <Field label="Rate cap (%)" hint="Optional">
                      <Input inputMode="decimal" value={form.loanCapRate} onChange={(event) => setValue("loanCapRate", event.target.value)} />
                    </Field>
                  </>
                ) : null}
                <Field label="Jurisdiction code" hint="Optional ISO country code; e.g. US, RO, or DE">
                  <Input value={form.loanJurisdiction} onChange={(event) => setValue("loanJurisdiction", event.target.value.toUpperCase())} placeholder="e.g. US" maxLength={8} />
                </Field>
                </div>
              </div>
            </details>
          </>
        ) : (
          <Field label={`Opening balance (${currency || "currency"})`} hint="Can be zero; use a minus sign only for a genuine negative asset balance.">
            <Input inputMode="decimal" value={form.openingBalance} onChange={(event) => setValue("openingBalance", event.target.value)} />
          </Field>
        )}

        {form.type === "credit_card" || form.type === "loan" ? (
          <div className={`${ui.formToggle} ${ui.formSpan}`}>
            <Toggle
              checked={form.generatePlannedPayments}
              onChange={(checked) => setValue("generatePlannedPayments", checked)}
              label="Include upcoming debt payments in planning"
              description={form.type === "loan" ? "Generate estimated installment obligations from this schedule." : "Turn recorded card statements into upcoming obligations."}
            />
          </div>
        ) : null}
        <Field label="Account colour">
          <input className={ui.colorInput} type="color" value={form.color} onChange={(event) => setValue("color", event.target.value)} />
        </Field>
        <div className={`${ui.inlineNotice} ${ui.formSpan}`}>
          <Landmark size={16} aria-hidden="true" />
          {form.type === "credit_card"
            ? "Card purchases are expenses on this account. Paying the card is a transfer from cash, so it never inflates spending. The limit does not affect net worth."
            : form.type === "loan"
              ? "Loan principal payments are transfers to the liability; only interest and fees count as spending. Future variable rates are estimates until confirmed."
              : "Future balances are calculated as opening balance plus signed actual transactions. Planned payments never change this number until paid."}
        </div>
        <button type="submit" hidden />
      </form>
      <FormMessage error={submitError} />
    </Modal>
  );
}

function AccountDetail({ account, rangeLabel, onClose, onArchive }: { account: Account | null; rangeLabel: string; onClose: () => void; onArchive: (account: Account) => Promise<void> }) {
  const history = useMemo(() => readList<Record<string, unknown>>(account, "balanceHistory", "history"), [account]);
  if (!account) return null;
  const balance = numberFrom(account.balanceMinor ?? account.currentBalanceMinor);
  const opening = numberFrom(account.openingBalanceMinor);
  const currency = stringFrom(account.currency, DEFAULT_CURRENCY);
  const historyValues = history.map((item) => numberFrom(readRecord(item).balanceMinor));
  return (
    <Modal
      open
      onClose={onClose}
      title={stringFrom(account.name, "Account")}
      description={`Actual balance history for ${rangeLabel} and reconciliation basis`}
      footer={
        <>
          <Button variant="ghost" icon={<Archive size={15} />} onClick={() => void onArchive(account)}>
            {Boolean(account.archivedAt ?? account.isArchived) ? "Restore account" : "Archive account"}
          </Button>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className={ui.metricGrid}>
        <Metric label="Current balance" value={formatMoney(balance, currency)} tone={balance < 0 ? "negative" : "accent"} />
        <Metric label="Opening balance" value={formatMoney(opening, currency)} detail={formatDate(account.openingDate ?? account.openingBalanceDate)} />
      </div>
      <Section title="Balance history" description={`Actual reconciled balance points in ${rangeLabel}`}>
        <div className={ui.sectionContentPadding}>
          {history.length ? (
            <SparkBars values={historyValues} labels={history.map((item) => formatDate(readRecord(item).date, { month: "short", year: "2-digit", day: undefined }))} tone="mixed" height={140} />
          ) : (
            <div className={ui.inlineNotice}>
              <LineChart size={16} /> No balance history exists in {rangeLabel}. This account may not have been open during the selected range.
            </div>
          )}
        </div>
      </Section>
      <div className={ui.summaryList}>
        <div className={ui.summaryRow}><span>Account type</span><strong>{stringFrom(account.customType ?? account.customTypeLabel ?? account.type, "Custom").replaceAll("_", " ")}</strong></div>
        <div className={ui.summaryRow}><span>Currency</span><strong>{currency}</strong></div>
        <div className={ui.summaryRow}><span>Reconciliation difference</span><strong>{formatMoney(account.reconciliationDifferenceMinor, currency)}</strong></div>
      </div>
      <div className={`${ui.inlineNotice} ${ui.noticeOffset}`}>
        <LineChart size={16} /> Balance history includes actual transactions only; scheduled and planned amounts are intentionally excluded.
      </div>
    </Modal>
  );
}
