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
import { useTranslations } from "@/i18n/client";
import type { Translator } from "@/i18n/runtime";
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
  ["current_account", "finance.accounts.types.currentAccount"],
  ["savings", "finance.accounts.types.savings"],
  ["cash", "finance.accounts.types.cash"],
  ["credit_card", "finance.accounts.types.creditCard"],
  ["loan", "finance.accounts.types.loan"],
  ["investment", "finance.accounts.types.investment"],
  ["custom", "finance.accounts.types.custom"],
] as const;

const liabilityTypes = new Set(["credit_card", "loan"]);

function addMonths(date: string, count: number) {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + count, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function percentInputToBps(
  value: string,
  label: string,
  translate: Translator["translate"],
  optional = false,
  allowNegative = false,
) {
  if (optional && !value.trim()) return null;
  const normalized = value.trim().replace(",", ".");
  if (!/^-?\d+(?:\.\d{0,2})?$/.test(normalized)) {
    throw new Error(translate("finance.accounts.validation.invalidPercentagePrecision", { label }));
  }
  const parsed = Number(normalized);
  if ((!allowNegative && parsed < 0) || parsed < -1_000 || parsed > 10_000) {
    throw new Error(translate("finance.accounts.validation.invalidValue", { label }));
  }
  return Math.round(parsed * 100);
}

function optionalMoneyInputToMinor(value: string, label: string, currency: string, translate: Translator["translate"]) {
  if (!value.trim()) return null;
  const result = moneyInputToMinor(value, currency);
  if (result === null || result < 0) throw new Error(translate("finance.accounts.validation.invalidMoney", { label, currency }));
  return result;
}

function optionalInteger(value: string, label: string, minimum: number, maximum: number, translate: Translator["translate"]) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(translate("finance.accounts.validation.invalidValue", { label }));
  }
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

function accountTypeLabel(type: string, translate: Translator["translate"]) {
  const normalized = type === "current" ? "current_account" : type;
  const definition = accountTypes.find(([value]) => value === normalized);
  return definition
    ? translate(definition[1])
    : translate("finance.accounts.types.custom");
}

export default function AccountsPage() {
  const t = useTranslations();
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
      setActionError(caught instanceof Error ? caught.message : t("finance.accounts.validation.updateFallback"));
    }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow={t("finance.accounts.header.eyebrow")}
        title={t("finance.accounts.title")}
        description={t("finance.accounts.header.description")}
        actions={<AddButton onClick={() => setCreateOpen(true)}>{t("finance.accounts.header.add")}</AddButton>}
      />

      <div className={ui.metricGrid}>
        <Metric label={t("finance.accounts.metrics.netValue")} value={formatMoney(total, workspaceCurrency)} tone={total >= 0 ? "accent" : "negative"} info={t("finance.accounts.metrics.netInfo", { currency: workspaceCurrency })} />
        <Metric label={t("finance.accounts.metrics.assets")} value={formatMoney(assets, workspaceCurrency)} detail={t("finance.accounts.metrics.assetCount", { count: activeAccounts.filter((item) => !liabilityTypes.has(stringFrom(readRecord(item).type))).length })} info={t("finance.accounts.metrics.assetsInfo", { currency: workspaceCurrency })} />
        <Metric label={t("finance.accounts.metrics.debt")} value={formatMoney(liabilities, workspaceCurrency)} tone={liabilities > 0 ? "warning" : "default"} info={t("finance.accounts.metrics.debtInfo", { currency: workspaceCurrency })} />
        <Metric label={t("finance.accounts.metrics.archived")} value={archivedAccounts.length} detail={t("finance.accounts.metrics.archivedDetail")} />
      </div>

      <Section
        title={t("finance.accounts.list.title")}
        description={t("finance.accounts.list.description")}
        action={
          <Tabs
            id="account-visibility"
            panelId="account-visibility-panel"
            label={t("finance.accounts.list.visibility")}
            value={filter}
            onChange={setFilter}
            items={[
              { value: "active", label: t("finance.accounts.list.active"), count: activeAccounts.length },
              { value: "archived", label: t("finance.accounts.list.archived"), count: archivedAccounts.length },
              { value: "all", label: t("finance.accounts.list.all"), count: accounts.length },
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
            emptyTitle={filter === "archived" ? t("finance.accounts.list.noArchived") : t("finance.accounts.list.createFirst")}
            emptyDescription={filter === "archived" ? t("finance.accounts.list.archivedDescription") : t("finance.accounts.list.createDescription")}
            action={filter !== "archived" ? <AddButton onClick={() => setCreateOpen(true)}>{t("finance.accounts.header.add")}</AddButton> : undefined}
          >
            <div className={ui.accountGrid}>
            {visibleAccounts.map((item, index) => {
              const account = readRecord(item);
              const archived = Boolean(account.archivedAt ?? account.isArchived);
              const type = stringFrom(account.type, "custom");
              const translatedType = account.customType || account.customTypeLabel
                ? stringFrom(account.customType ?? account.customTypeLabel)
                : accountTypeLabel(type, t);
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
                        <strong>{stringFrom(account.name, t("finance.accounts.card.unnamed"))}</strong>
                        <small>{account.institution
                          ? t("finance.accounts.card.typeCurrencyInstitution", { type: translatedType, currency, institution: stringFrom(account.institution) })
                          : t("finance.accounts.card.typeCurrency", { type: translatedType, currency })}</small>
                      </span>
                    </div>
                    {archived ? <Pill>{t("finance.accounts.card.archived")}</Pill> : <IconButton label={isLiability ? t("finance.accounts.card.manageDebt") : t("finance.accounts.card.details")} onClick={openDetails}><Ellipsis size={18} /></IconButton>}
                  </div>
                  <span className={ui.accountBalanceLabel}>{isLiability ? (balance > 0 ? t("finance.accounts.card.creditBalance") : t("finance.accounts.card.outstanding")) : t("finance.accounts.card.currentBalance")}</span>
                  <strong className={`${ui.accountBalance} ${debt > 0 ? ui.negative : ""}`}>{formatMoney(isLiability ? (balance > 0 ? balance : debt) : balance, currency)}</strong>
                  {type === "credit_card" && Object.keys(creditMetrics).length ? (
                    <div className={ui.liabilitySnapshot}>
                      <div className={ui.liabilityProgress} aria-label={utilizationBps >= 0 ? t("finance.accounts.card.utilization", { percent: utilizationBps / 100 }) : t("finance.accounts.card.utilizationUnavailable")}>
                        <span style={{ width: `${utilizationBps < 0 ? 0 : Math.min(100, utilizationBps / 100)}%` }} />
                      </div>
                      <div className={ui.liabilityFacts}>
                        <span>{t("finance.accounts.card.available")} <strong>{formatMoney(creditMetrics.availableCreditMinor, currency)}</strong></span>
                        <span>{utilizationBps >= 0 ? t("finance.accounts.card.used", { percent: utilizationBps / 100 }) : t("finance.accounts.card.noLimit")}</span>
                      </div>
                    </div>
                  ) : null}
                  {type === "loan" && Object.keys(loanMetrics).length ? (
                    <div className={ui.liabilitySnapshot}>
                      <div className={`${ui.liabilityProgress} ${ui.loanProgress}`} aria-label={t("finance.accounts.card.repaymentAria", { percent: repaymentPercent })}>
                        <span style={{ width: `${repaymentPercent}%` }} />
                      </div>
                      <div className={ui.liabilityFacts}>
                        <span>{t("finance.accounts.card.original")} <strong>{formatMoney(originalPrincipal, currency)}</strong></span>
                        <span>{t("finance.accounts.card.repaid", { percent: repaymentPercent })}</span>
                      </div>
                    </div>
                  ) : null}
                  <div className={ui.accountMeta}>
                    <span>{t(isLiability ? "finance.accounts.card.openingDebt" : "finance.accounts.card.opening", { amount: formatMoney(isLiability ? Math.max(0, -numberFrom(account.openingBalanceMinor)) : account.openingBalanceMinor, currency) })}</span>
                    <span>{t("finance.accounts.card.asOf", { date: formatDate(account.openingDate ?? account.openingBalanceDate ?? account.createdAt, { day: "2-digit", month: "short", year: undefined }) })}</span>
                  </div>
                  <div className={ui.accountActions}>
                    <Button variant="ghost" onClick={openDetails}>{isLiability ? t("finance.accounts.card.manageDebt") : t("finance.accounts.card.balanceHistory")}</Button>
                    <Button variant="ghost" onClick={() => void archiveAccount(account)}>{archived ? t("finance.accounts.card.restore") : t("finance.accounts.card.archive")}</Button>
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
  const t = useTranslations();
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
  const loanReferenceIndexSuggestions = LOAN_REFERENCE_INDEX_SUGGESTIONS.map((suggestion) => ({
    value: suggestion.value,
    label: t(suggestion.labelKey),
    description: t(suggestion.descriptionKey),
  }));
  const loanIntervalMonthSuggestions = LOAN_INTERVAL_MONTH_SUGGESTIONS.map((suggestion) => ({
    value: suggestion.value,
    label: t(suggestion.labelKey),
  }));

  const { submit, submitting, submitError, setSubmitError } = useSubmit(async () => {
    if (!form.name.trim()) throw new Error(t("finance.accounts.validation.accountName"));
    if (!isSupportedCurrency(currency)) throw new Error(t("finance.accounts.validation.currency"));
    if (!form.openingDate) throw new Error(t("finance.accounts.validation.balanceDate"));
    if (form.type === "custom" && !form.customTypeLabel.trim()) throw new Error(t("finance.accounts.validation.customType"));

    let openingBalanceMinor = moneyInputToMinor(form.openingBalance, currency);
    let creditLimitMinor: number | null = null;
    let creditCard: Record<string, unknown> | undefined;
    let loan: Record<string, unknown> | undefined;

    if (form.type === "credit_card") {
      const limit = moneyInputToMinor(form.cardLimit, currency);
      const enteredAmount = moneyInputToMinor(form.cardOpeningAmount, currency);
      if (limit === null || limit <= 0) throw new Error(t("finance.accounts.validation.creditLimit"));
      if (enteredAmount === null || enteredAmount < 0) throw new Error(t("finance.accounts.validation.openingCardAmount"));
      if (form.cardOpeningMode === "available" && enteredAmount > limit) throw new Error(t("finance.accounts.validation.availableExceedsLimit"));
      const outstanding = form.cardOpeningMode === "available" ? limit - enteredAmount : enteredAmount;
      openingBalanceMinor = -outstanding;
      creditLimitMinor = limit;
      const minimumPaymentRateBps = form.cardMinimumMode === "percentage"
        ? percentInputToBps(form.cardMinimumRate, t("finance.accounts.validation.labels.minimumPaymentPercentage"), t)
        : null;
      const minimumPaymentFixedMinor = form.cardMinimumMode === "fixed"
        ? optionalMoneyInputToMinor(form.cardMinimumFixed, t("finance.accounts.validation.labels.fixedMinimumPayment"), currency, t)
        : null;
      if (form.cardMinimumMode === "fixed" && minimumPaymentFixedMinor === null) throw new Error(t("finance.accounts.validation.fixedMinimum"));
      creditCard = {
        creditLimitMinor: limit,
        statementDay: optionalInteger(form.cardStatementDay, t("finance.accounts.validation.labels.statementDay"), 1, 31, t),
        dueDay: optionalInteger(form.cardDueDay, t("finance.accounts.validation.labels.dueDay"), 1, 31, t),
        gracePeriodDays: optionalInteger(form.cardGraceDays, t("finance.accounts.validation.labels.gracePeriod"), 0, 180, t),
        purchaseAprBps: percentInputToBps(form.cardApr, t("finance.accounts.validation.labels.purchaseApr"), t, true),
        minimumPaymentMode: form.cardMinimumMode,
        minimumPaymentRateBps,
        minimumPaymentFixedMinor,
        paymentPreference: form.cardPaymentPreference,
        generatePlannedPayments: form.generatePlannedPayments,
      };
    } else if (form.type === "loan") {
      const outstanding = moneyInputToMinor(form.loanOutstanding, currency);
      if (outstanding === null || outstanding <= 0) throw new Error(t("finance.accounts.validation.loanOutstanding"));
      const originalPrincipal = optionalMoneyInputToMinor(form.loanOriginalPrincipal, t("finance.accounts.validation.labels.originalPrincipal"), currency, t) ?? outstanding;
      if (originalPrincipal <= 0) throw new Error(t("finance.accounts.validation.originalPrincipalPositive"));
      const termMonths = optionalInteger(form.loanTermMonths, t("finance.accounts.validation.labels.loanTerm"), 1, 1200, t);
      const paymentIntervalMonths = optionalInteger(form.loanPaymentIntervalMonths, t("finance.accounts.validation.labels.paymentInterval"), 1, 120, t);
      if (termMonths === null || paymentIntervalMonths === null) throw new Error(t("finance.accounts.validation.termAndInterval"));
      if (!form.loanOriginationDate || !form.loanFirstPaymentDate) throw new Error(t("finance.accounts.validation.loanDates"));
      openingBalanceMinor = -outstanding;
      const rate = form.loanRateType === "fixed"
        ? {
            rateType: "fixed",
            effectiveFrom: form.loanOriginationDate,
            effectiveTo: null,
            fixedRateBps: percentInputToBps(form.loanFixedRate, t("finance.accounts.validation.labels.fixedAnnualRate"), t),
          }
        : {
            rateType: "variable",
            effectiveFrom: form.loanOriginationDate,
            effectiveTo: null,
            referenceIndex: form.loanReferenceIndex.trim(),
            referenceTenorMonths: optionalInteger(form.loanReferenceTenorMonths, t("finance.accounts.validation.labels.referenceTenor"), 1, 120, t),
            referenceRateBps: percentInputToBps(form.loanReferenceRate, t("finance.accounts.validation.labels.referenceRate"), t, false, true),
            marginBps: percentInputToBps(form.loanMargin, t("finance.accounts.validation.labels.lenderMargin"), t, false, true),
            resetFrequencyMonths: optionalInteger(form.loanResetFrequencyMonths, t("finance.accounts.validation.labels.resetFrequency"), 1, 120, t),
            nextResetDate: form.loanNextResetDate || null,
            observationLagMonths: optionalInteger(form.loanObservationLagMonths, t("finance.accounts.validation.labels.observationLag"), 0, 120, t) ?? 0,
            floorRateBps: percentInputToBps(form.loanFloorRate, t("finance.accounts.validation.labels.rateFloor"), t, true, true),
            capRateBps: percentInputToBps(form.loanCapRate, t("finance.accounts.validation.labels.rateCap"), t, true, true),
          };
      if (form.loanRateType === "variable" && !form.loanReferenceIndex.trim()) throw new Error(t("finance.accounts.validation.referenceIndex"));
      if (form.loanRateType === "variable" && (rate.referenceTenorMonths === null || rate.resetFrequencyMonths === null)) {
        throw new Error(t("finance.accounts.validation.indexIntervals"));
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

    if (openingBalanceMinor === null) throw new Error(t("finance.accounts.validation.openingBalance", { currency }));
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

  const accountLabel = form.type === "credit_card"
    ? t("finance.accounts.form.fields.cardName")
    : form.type === "loan"
      ? t("finance.accounts.form.fields.loanName")
      : t("finance.accounts.form.fields.accountName");
  const formDescription = form.type === "credit_card"
    ? t("finance.accounts.form.descriptions.card")
    : form.type === "loan"
      ? t("finance.accounts.form.descriptions.loan")
      : t("finance.accounts.form.descriptions.account");
  const currencyLabel = currency || t("finance.accounts.form.fields.currencyFallback");

  return (
    <Modal
      open={open}
      size={isLiability ? "xl" : "lg"}
      onClose={() => { setSubmitError(null); onClose(); }}
      title={t("finance.accounts.form.title")}
      description={formDescription}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("common.actions.cancel")}</Button>
          <Button disabled={submitting} onClick={() => void submit()}>{submitting ? t("finance.accounts.form.actions.creating") : t("finance.accounts.form.actions.create")}</Button>
        </>
      }
    >
      <form
        className={`${ui.formGrid} ${isLiability ? ui.accountLiabilityFormGrid : ""}`}
        onSubmit={(event) => void submit(event)}
      >
        <Field label={accountLabel} className={ui.formSpan}>
          <Input autoFocus value={form.name} onChange={(event) => setValue("name", event.target.value)} placeholder={form.type === "loan" ? t("finance.accounts.form.fields.loanPlaceholder") : form.type === "credit_card" ? t("finance.accounts.form.fields.cardPlaceholder") : t("finance.accounts.form.fields.accountPlaceholder")} maxLength={80} />
        </Field>
        <Field label={t("finance.accounts.form.fields.accountType")}>
          <Select value={form.type} onValueChange={(value) => setValue("type", value)}>
            {accountTypes.map(([value, labelKey]) => <option value={value} key={value}>{t(labelKey)}</option>)}
          </Select>
        </Field>
        <Field
          htmlFor="account-currency"
          label={t("finance.accounts.form.fields.currency")}
          hint={t("finance.accounts.form.fields.currencyHint", { currency: defaultCurrency })}
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
        <Field label={t("finance.accounts.form.fields.institution")} hint={t("finance.accounts.form.fields.institutionHint")}>
          <Input value={form.institution} onChange={(event) => setValue("institution", event.target.value)} placeholder={t("finance.accounts.form.fields.institutionPlaceholder")} maxLength={120} />
        </Field>
        <Field label={t("finance.accounts.form.fields.balanceDate")}>
          <Input type="date" max={today} value={form.openingDate} onChange={(event) => setValue("openingDate", event.target.value)} />
        </Field>
        {form.type === "custom" ? (
          <Field label={t("finance.accounts.form.fields.customType")} className={ui.formSpan}>
            <Input value={form.customTypeLabel} onChange={(event) => setValue("customTypeLabel", event.target.value)} placeholder={t("finance.accounts.form.fields.customTypePlaceholder")} maxLength={60} />
          </Field>
        ) : null}

        {form.type === "credit_card" ? (
          <>
            <div className={`${ui.formSectionTitle} ${ui.formSpan}`}><strong>{t("finance.accounts.form.card.section")}</strong><span>{t("finance.accounts.form.card.sectionDescription")}</span></div>
            <Field label={t("finance.accounts.form.card.creditLimit", { currency: currencyLabel })} hint={t("finance.accounts.form.card.creditLimitHint")}>
              <Input inputMode="decimal" value={form.cardLimit} onChange={(event) => setValue("cardLimit", event.target.value)} placeholder="5000" />
            </Field>
            <Field label={t("finance.accounts.form.card.openingRepresents")}>
              <Select value={form.cardOpeningMode} onValueChange={(value) => setValue("cardOpeningMode", value as AccountFormDraft["cardOpeningMode"])}>
                <option value="outstanding">{t("finance.accounts.form.card.alreadyUsed")}</option>
                <option value="available">{t("finance.accounts.form.card.stillAvailable")}</option>
              </Select>
            </Field>
            <Field label={t(form.cardOpeningMode === "outstanding" ? "finance.accounts.form.card.outstandingDebt" : "finance.accounts.form.card.availableCredit", { currency: currencyLabel })}>
              <Input inputMode="decimal" value={form.cardOpeningAmount} onChange={(event) => setValue("cardOpeningAmount", event.target.value)} />
            </Field>
            <div className={`${ui.derivedValue} ${ui.accountDerivedValue} ${ui.formSpan}`} aria-live="polite">
              <span>{t("finance.accounts.form.card.recordedDebt")}</span>
              <strong>{formatMoney(previewOutstanding, currency || DEFAULT_CURRENCY)}</strong>
            </div>
            <details className={`${ui.formDisclosure} ${ui.formSpan}`}>
              <summary className={ui.formDisclosureSummary} aria-label={t("finance.accounts.form.card.advancedAria")}>
                <span>
                  <strong>{t("finance.accounts.form.card.advanced")}</strong>
                  <small>{t("finance.accounts.form.card.advancedDescription")}</small>
                </span>
                <ChevronDown size={18} aria-hidden="true" />
              </summary>
              <div className={ui.formDisclosureBody}>
                <div className={`${ui.formGrid} ${ui.accountAdvancedGrid}`}>
                <Field label={t("finance.accounts.form.card.statementDay")} hint={t("finance.accounts.form.card.statementDayHint")}>
                  <Input type="number" min={1} max={31} value={form.cardStatementDay} onChange={(event) => setValue("cardStatementDay", event.target.value)} placeholder={t("finance.accounts.form.card.statementDayPlaceholder")} />
                </Field>
                <Field label={t("finance.accounts.form.card.dueDay")} hint={t("finance.accounts.form.card.dueDayHint")}>
                  <Input type="number" min={1} max={31} value={form.cardDueDay} onChange={(event) => setValue("cardDueDay", event.target.value)} placeholder={t("finance.accounts.form.card.dueDayPlaceholder")} />
                </Field>
                <Field label={t("finance.accounts.form.card.gracePeriod")} hint={t("finance.accounts.form.card.gracePeriodHint")}>
                  <Input type="number" min={0} max={180} value={form.cardGraceDays} onChange={(event) => setValue("cardGraceDays", event.target.value)} />
                </Field>
                <Field label={t("finance.accounts.form.card.purchaseApr")} hint={t("finance.accounts.form.card.purchaseAprHint")}>
                  <Input inputMode="decimal" value={form.cardApr} onChange={(event) => setValue("cardApr", event.target.value)} placeholder={t("finance.accounts.form.card.purchaseAprPlaceholder")} />
                </Field>
                <Field label={t("finance.accounts.form.card.minimumRule")}>
                  <Select value={form.cardMinimumMode} onValueChange={(value) => setValue("cardMinimumMode", value as AccountFormDraft["cardMinimumMode"])}>
                    <option value="manual">{t("finance.accounts.form.card.minimumManual")}</option>
                    <option value="percentage">{t("finance.accounts.form.card.minimumPercentage")}</option>
                    <option value="fixed">{t("finance.accounts.form.card.minimumFixed")}</option>
                  </Select>
                </Field>
                {form.cardMinimumMode === "percentage" ? (
                  <Field label={t("finance.accounts.form.card.minimumPaymentPercent")}>
                    <Input inputMode="decimal" value={form.cardMinimumRate} onChange={(event) => setValue("cardMinimumRate", event.target.value)} placeholder={t("finance.accounts.form.card.minimumPaymentPlaceholder")} />
                  </Field>
                ) : form.cardMinimumMode === "fixed" ? (
                  <Field label={t("finance.accounts.form.card.fixedMinimum", { currency: currencyLabel })}>
                    <Input inputMode="decimal" value={form.cardMinimumFixed} onChange={(event) => setValue("cardMinimumFixed", event.target.value)} />
                  </Field>
                ) : <div />}
                <Field label={t("finance.accounts.form.card.paymentPlan")} className={ui.formSpan}>
                  <Select value={form.cardPaymentPreference} onValueChange={(value) => setValue("cardPaymentPreference", value as AccountFormDraft["cardPaymentPreference"])}>
                    <option value="full_statement">{t("finance.accounts.form.card.fullStatement")}</option>
                    <option value="minimum">{t("finance.accounts.form.card.minimumDue")}</option>
                    <option value="custom">{t("finance.accounts.form.card.customAmount")}</option>
                  </Select>
                </Field>
                </div>
              </div>
            </details>
          </>
        ) : form.type === "loan" ? (
          <>
            <div className={`${ui.formSectionTitle} ${ui.formSpan}`}><strong>{t("finance.accounts.form.loan.section")}</strong><span>{t("finance.accounts.form.loan.sectionDescription")}</span></div>
            <Field label={t("finance.accounts.form.loan.outstanding", { currency: currencyLabel })} hint={t("finance.accounts.form.loan.outstandingHint")}>
              <Input inputMode="decimal" value={form.loanOutstanding} onChange={(event) => setValue("loanOutstanding", event.target.value)} placeholder={t("finance.accounts.form.loan.outstandingPlaceholder")} />
            </Field>
            <Field label={t("finance.accounts.form.loan.original", { currency: currencyLabel })} hint={t("finance.accounts.form.loan.originalHint")}>
              <Input inputMode="decimal" value={form.loanOriginalPrincipal} onChange={(event) => setValue("loanOriginalPrincipal", event.target.value)} />
            </Field>
            <Field label={t("finance.accounts.form.loan.originationDate")}>
              <Input type="date" max={today} value={form.loanOriginationDate} onChange={(event) => setValue("loanOriginationDate", event.target.value)} />
            </Field>
            <Field label={t("finance.accounts.form.loan.firstPaymentDate")}>
              <Input type="date" value={form.loanFirstPaymentDate} onChange={(event) => setValue("loanFirstPaymentDate", event.target.value)} />
            </Field>
            <Field label={t("finance.accounts.form.loan.term")} hint={t("finance.accounts.form.loan.termHint")}>
              <Input type="number" min={1} max={1200} value={form.loanTermMonths} onChange={(event) => setValue("loanTermMonths", event.target.value)} />
            </Field>
            <Field label={t("finance.accounts.form.loan.cadence")}>
              <Select value={form.loanPaymentFrequency} onValueChange={(value) => {
                const frequency = value as AccountFormDraft["loanPaymentFrequency"];
                setForm((current) => ({ ...current, loanPaymentFrequency: frequency, loanPaymentIntervalMonths: frequency === "monthly" ? "1" : frequency === "quarterly" ? "3" : frequency === "yearly" ? "12" : current.loanPaymentIntervalMonths }));
              }}>
                <option value="monthly">{t("finance.accounts.form.loan.monthly")}</option>
                <option value="quarterly">{t("finance.accounts.form.loan.quarterly")}</option>
                <option value="yearly">{t("finance.accounts.form.loan.yearly")}</option>
                <option value="custom">{t("finance.accounts.form.loan.customInterval")}</option>
              </Select>
            </Field>
            <Field label={t("finance.accounts.form.loan.rateType")}>
              <Select value={form.loanRateType} onValueChange={(value) => setValue("loanRateType", value as AccountFormDraft["loanRateType"])}>
                <option value="fixed">{t("finance.accounts.form.loan.fixed")}</option>
                <option value="variable">{t("finance.accounts.form.loan.variable")}</option>
              </Select>
            </Field>
            {form.loanRateType === "fixed" ? (
              <Field label={t("finance.accounts.form.loan.annualRate")}>
                <Input inputMode="decimal" value={form.loanFixedRate} onChange={(event) => setValue("loanFixedRate", event.target.value)} />
              </Field>
            ) : (
              <>
                <Field label={t("finance.accounts.form.loan.referenceIndex")} hint={t("finance.accounts.form.loan.referenceHint")}>
                  <SuggestionInput
                    value={form.loanReferenceIndex}
                    suggestions={loanReferenceIndexSuggestions}
                    onValueChange={(value) => setValue("loanReferenceIndex", value)}
                    placeholder={t("finance.accounts.form.loan.referencePlaceholder")}
                    maxLength={80}
                  />
                </Field>
                <Field label={t("finance.accounts.form.loan.currentIndexRate")}>
                  <Input inputMode="decimal" value={form.loanReferenceRate} onChange={(event) => setValue("loanReferenceRate", event.target.value)} placeholder={t("finance.accounts.form.loan.currentIndexPlaceholder")} />
                </Field>
                <Field label={t("finance.accounts.form.loan.margin")}>
                  <Input inputMode="decimal" value={form.loanMargin} onChange={(event) => setValue("loanMargin", event.target.value)} placeholder={t("finance.accounts.form.loan.marginPlaceholder")} />
                </Field>
              </>
            )}
            <details className={`${ui.formDisclosure} ${ui.formSpan}`}>
              <summary className={ui.formDisclosureSummary} aria-label={t("finance.accounts.form.loan.advancedAria")}>
                <span>
                  <strong>{t("finance.accounts.form.loan.advanced")}</strong>
                  <small>{t("finance.accounts.form.loan.advancedDescription")}</small>
                </span>
                <ChevronDown size={18} aria-hidden="true" />
              </summary>
              <div className={ui.formDisclosureBody}>
                <div className={`${ui.formGrid} ${ui.accountAdvancedGrid}`}>
                  <Field label={t("finance.accounts.form.loan.maturity")} hint={t("finance.accounts.form.loan.maturityHint")}>
                    <Input type="date" value={form.loanMaturityDate} onChange={(event) => setValue("loanMaturityDate", event.target.value)} />
                  </Field>
                  <Field label={t("finance.accounts.form.loan.everyMonths")} hint={form.loanPaymentFrequency === "custom" ? t("finance.accounts.form.loan.customInterval") : t("finance.accounts.form.loan.derivedInterval")}>
                    <Input type="number" min={1} max={120} disabled={form.loanPaymentFrequency !== "custom"} value={form.loanPaymentIntervalMonths} onChange={(event) => setValue("loanPaymentIntervalMonths", event.target.value)} />
                  </Field>
            <Field label={t("finance.accounts.form.loan.amortization")}>
              <Select value={form.loanAmortization} onValueChange={(value) => setValue("loanAmortization", value as AccountFormDraft["loanAmortization"])}>
                <option value="annuity">{t("finance.accounts.form.loan.annuity")}</option>
                <option value="equal_principal">{t("finance.accounts.form.loan.equalPrincipal")}</option>
                <option value="interest_only">{t("finance.accounts.form.loan.interestOnly")}</option>
              </Select>
            </Field>
            <Field label={t("finance.accounts.form.loan.paymentAccount")} hint={availableSourceAccounts.length ? t("finance.accounts.form.loan.paymentAccountHint") : t("finance.accounts.form.loan.noCashAccount")}>
              <Select value={form.loanPaymentAccountId} onValueChange={(value) => setValue("loanPaymentAccountId", value)}>
                <option value="">{t("finance.accounts.form.loan.chooseWhenPaying")}</option>
                {availableSourceAccounts.map((item) => {
                  const account = readRecord(item);
                  return <option value={stringFrom(account.id)} key={stringFrom(account.id)}>{stringFrom(account.name)} · {stringFrom(account.currency, DEFAULT_CURRENCY)}</option>;
                })}
              </Select>
            </Field>
                {form.loanRateType === "variable" ? (
                  <>
                    <Field label={t("finance.accounts.form.loan.indexTenor")} hint={t("finance.accounts.form.loan.commonIntervals")}>
                      <SuggestionInput
                        value={form.loanReferenceTenorMonths}
                        suggestions={loanIntervalMonthSuggestions}
                        onValueChange={(value) => setValue("loanReferenceTenorMonths", value)}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={3}
                      />
                    </Field>
                    <Field label={t("finance.accounts.form.loan.resetsEvery")}>
                      <SuggestionInput
                        value={form.loanResetFrequencyMonths}
                        suggestions={loanIntervalMonthSuggestions}
                        onValueChange={(value) => setValue("loanResetFrequencyMonths", value)}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={3}
                      />
                    </Field>
                    <Field label={t("finance.accounts.form.loan.nextReset")} hint={t("finance.accounts.form.loan.optional")}>
                      <Input type="date" value={form.loanNextResetDate} onChange={(event) => setValue("loanNextResetDate", event.target.value)} />
                    </Field>
                    <Field label={t("finance.accounts.form.loan.observationLag")} hint={t("finance.accounts.form.loan.observationLagHint")}>
                      <Input type="number" min={0} max={120} value={form.loanObservationLagMonths} onChange={(event) => setValue("loanObservationLagMonths", event.target.value)} />
                    </Field>
                    <Field label={t("finance.accounts.form.loan.rateFloor")} hint={t("finance.accounts.form.loan.optional")}>
                      <Input inputMode="decimal" value={form.loanFloorRate} onChange={(event) => setValue("loanFloorRate", event.target.value)} />
                    </Field>
                    <Field label={t("finance.accounts.form.loan.rateCap")} hint={t("finance.accounts.form.loan.optional")}>
                      <Input inputMode="decimal" value={form.loanCapRate} onChange={(event) => setValue("loanCapRate", event.target.value)} />
                    </Field>
                  </>
                ) : null}
                <Field label={t("finance.accounts.form.loan.jurisdiction")} hint={t("finance.accounts.form.loan.jurisdictionHint")}>
                  <Input value={form.loanJurisdiction} onChange={(event) => setValue("loanJurisdiction", event.target.value.toUpperCase())} placeholder={t("finance.accounts.form.loan.jurisdictionPlaceholder")} maxLength={8} />
                </Field>
                </div>
              </div>
            </details>
          </>
        ) : (
          <Field label={t("finance.accounts.form.asset.openingBalance", { currency: currencyLabel })} hint={t("finance.accounts.form.asset.openingHint")}>
            <Input inputMode="decimal" value={form.openingBalance} onChange={(event) => setValue("openingBalance", event.target.value)} />
          </Field>
        )}

        {form.type === "credit_card" || form.type === "loan" ? (
          <div className={`${ui.formToggle} ${ui.formSpan}`}>
            <Toggle
              checked={form.generatePlannedPayments}
              onChange={(checked) => setValue("generatePlannedPayments", checked)}
              label={t("finance.accounts.form.includePlanning")}
              description={form.type === "loan" ? t("finance.accounts.form.loan.planningDescription") : t("finance.accounts.form.card.planningDescription")}
            />
          </div>
        ) : null}
        <Field label={t("finance.accounts.form.fields.accountColour")}>
          <input className={ui.colorInput} type="color" value={form.color} onChange={(event) => setValue("color", event.target.value)} />
        </Field>
        <div className={`${ui.inlineNotice} ${ui.formSpan}`}>
          <Landmark size={16} aria-hidden="true" />
          {form.type === "credit_card"
            ? t("finance.accounts.form.card.notice")
            : form.type === "loan"
              ? t("finance.accounts.form.loan.notice")
              : t("finance.accounts.form.asset.notice")}
        </div>
        <button type="submit" hidden />
      </form>
      <FormMessage error={submitError} />
    </Modal>
  );
}

function AccountDetail({ account, rangeLabel, onClose, onArchive }: { account: Account | null; rangeLabel: string; onClose: () => void; onArchive: (account: Account) => Promise<void> }) {
  const t = useTranslations();
  const history = useMemo(() => readList<Record<string, unknown>>(account, "balanceHistory", "history"), [account]);
  if (!account) return null;
  const balance = numberFrom(account.balanceMinor ?? account.currentBalanceMinor);
  const opening = numberFrom(account.openingBalanceMinor);
  const currency = stringFrom(account.currency, DEFAULT_CURRENCY);
  const type = stringFrom(account.type, "custom");
  const typeLabel = account.customType || account.customTypeLabel
    ? stringFrom(account.customType ?? account.customTypeLabel)
    : accountTypeLabel(type, t);
  const historyValues = history.map((item) => numberFrom(readRecord(item).balanceMinor));
  return (
    <Modal
      open
      onClose={onClose}
      title={stringFrom(account.name, t("finance.accounts.detail.accountFallback"))}
      description={t("finance.accounts.detail.description", { range: rangeLabel })}
      footer={
        <>
          <Button variant="ghost" icon={<Archive size={15} />} onClick={() => void onArchive(account)}>
            {Boolean(account.archivedAt ?? account.isArchived) ? t("finance.accounts.detail.restore") : t("finance.accounts.detail.archive")}
          </Button>
          <Button variant="secondary" onClick={onClose}>{t("common.actions.close")}</Button>
        </>
      }
    >
      <div className={ui.metricGrid}>
        <Metric label={t("finance.accounts.detail.currentBalance")} value={formatMoney(balance, currency)} tone={balance < 0 ? "negative" : "accent"} />
        <Metric label={t("finance.accounts.detail.openingBalance")} value={formatMoney(opening, currency)} detail={formatDate(account.openingDate ?? account.openingBalanceDate)} />
      </div>
      <Section title={t("finance.accounts.detail.history")} description={t("finance.accounts.detail.historyDescription", { range: rangeLabel })}>
        <div className={ui.sectionContentPadding}>
          {history.length ? (
            <SparkBars values={historyValues} labels={history.map((item) => formatDate(readRecord(item).date, { month: "short", year: "2-digit", day: undefined }))} tone="mixed" height={140} />
          ) : (
            <div className={ui.inlineNotice}>
              <LineChart size={16} /> {t("finance.accounts.detail.noHistory", { range: rangeLabel })}
            </div>
          )}
        </div>
      </Section>
      <div className={ui.summaryList}>
        <div className={ui.summaryRow}><span>{t("finance.accounts.detail.accountType")}</span><strong>{typeLabel}</strong></div>
        <div className={ui.summaryRow}><span>{t("finance.accounts.detail.currency")}</span><strong>{currency}</strong></div>
        <div className={ui.summaryRow}><span>{t("finance.accounts.detail.reconciliation")}</span><strong>{formatMoney(account.reconciliationDifferenceMinor, currency)}</strong></div>
      </div>
      <div className={`${ui.inlineNotice} ${ui.noticeOffset}`}>
        <LineChart size={16} /> {t("finance.accounts.detail.notice")}
      </div>
    </Modal>
  );
}
