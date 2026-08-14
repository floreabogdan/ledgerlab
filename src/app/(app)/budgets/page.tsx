"use client";

import { AlertTriangle, Copy, Gauge, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { useDateRange } from "@/components/date-range-context";
import { useTranslations, useTranslator } from "@/i18n/client";
import { DEFAULT_CURRENCY } from "@/lib/currencies";
import { monthBounds } from "@/lib/domain/dates";
import {
  AddButton,
  Button,
  DataState,
  Field,
  FormMessage,
  formatMoney,
  IconButton,
  Input,
  Metric,
  Modal,
  moneyInputToMinor,
  minorToInput,
  monthKey,
  MonthStepper,
  numberFrom,
  Page,
  Pill,
  Progress,
  readList,
  readRecord,
  requestJson,
  ResponsiveTable,
  Section,
  Select,
  stringFrom,
  useJson,
  useSubmit,
  ViewHeader,
} from "../_components/feature-kit";
import ui from "../_components/pages.module.css";

type Row = Record<string, unknown>;

function reportingPlannedExpenseMinor(value: unknown) {
  const row = readRecord(value);
  return Math.max(0, numberFrom(row.reportingSpendingAmountMinor));
}

function previousMonth(value: string) {
  const date = new Date(`${value}-01T12:00:00`);
  date.setMonth(date.getMonth() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export default function BudgetsPage() {
  const t = useTranslations();
  const translator = useTranslator();
  const { range, setRange } = useDateRange();
  const [month, setMonth] = useState(() => range.to.slice(0, 7) || monthKey());
  useEffect(() => {
    queueMicrotask(() => setMonth(range.to.slice(0, 7)));
  }, [range.to]);
  const exactMonth = monthBounds(month);
  const rangeMatchesMonth = range.from === exactMonth.start && range.to === exactMonth.end;
  const selectMonth = (value: string) => {
    setMonth(value);
    const bounds = monthBounds(value);
    setRange({ from: bounds.start, to: bounds.end });
  };
  const { data: raw, loading, error, reload } = useJson<Record<string, unknown>>(`/api/budgets?month=${month}`, {});
  const [yearNumber, monthNumber] = month.split("-").map(Number);
  const endDate = `${month}-${String(new Date(yearNumber, monthNumber, 0).getDate()).padStart(2, "0")}`;
  const { data: plannedRaw } = useJson<Record<string, unknown>>(`/api/planned?from=${month}-01&to=${endDate}`, {});
  const currency = stringFrom(readRecord(raw).currency ?? readRecord(plannedRaw).currency, DEFAULT_CURRENCY).toUpperCase();
  const budgets = readList<Row>(raw, "budgets");
  const plannedOccurrences = readList<Row>(plannedRaw, "occurrences", "planned");
  const categories = readList<Row>(raw, "categories").filter((item) => !Boolean(readRecord(item).archivedAt ?? readRecord(item).isArchived));
  const summary = readRecord(readRecord(raw).summary ?? readRecord(readRecord(raw).data).summary);
  const [editing, setEditing] = useState<Row | null | "new">(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const totalBudget = numberFrom(summary.totalBudgetMinor, budgets.reduce((sum, item) => sum + numberFrom(readRecord(item).amountMinor ?? readRecord(item).budgetMinor), 0));
  const spent = numberFrom(summary.spentMinor, budgets.reduce((sum, item) => sum + numberFrom(readRecord(item).spentMinor ?? readRecord(item).actualMinor), 0));
  const planned = numberFrom(summary.plannedMinor, plannedOccurrences.reduce((sum, item) => {
    const row = readRecord(item);
    return sum + (stringFrom(row.direction ?? row.type) === "expense" && !["paid", "skipped", "cancelled"].includes(stringFrom(row.status)) ? reportingPlannedExpenseMinor(row) : 0);
  }, 0));
  const remaining = totalBudget - spent;
  const overCount = budgets.filter((item) => {
    const row = readRecord(item);
    return numberFrom(row.spentMinor ?? row.actualMinor) > numberFrom(row.amountMinor ?? row.budgetMinor);
  }).length;

  async function copyBudgets() {
    setActionError(null); setMessage(null);
    try {
      await requestJson("/api/budgets", { method: "POST", body: JSON.stringify({ action: "copy", sourceMonth: previousMonth(month), targetMonth: month, month }) }, translator);
      setMessage(t("planning.budgets.feedback.copied"));
      await reload();
    } catch (caught) { setActionError(caught instanceof Error ? caught.message : t("planning.budgets.feedback.copyFailed")); }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow={t("planning.budgets.header.eyebrow")}
        title={t("planning.budgets.header.title")}
        description={t("planning.budgets.header.description")}
        actions={<AddButton onClick={() => setEditing("new")}>{t("planning.budgets.actions.addCategoryBudget")}</AddButton>}
      />
      <div className={ui.toolbar}>
        <div className={ui.toolbarGroup}>
          <MonthStepper value={month} onChange={selectMonth} />
          {!rangeMatchesMonth ? <Pill tone="info">{t("planning.budgets.range.endMonth")}</Pill> : null}
        </div>
        <Button variant="secondary" icon={<Copy size={15} />} onClick={() => void copyBudgets()}>{t("planning.budgets.actions.copyPreviousMonth")}</Button>
      </div>
      <FormMessage error={actionError} success={message} />

      <div className={ui.metricGrid}>
        <Metric label={t("planning.budgets.metrics.monthlyBudget.label")} value={formatMoney(totalBudget)} tone="accent" info={t("planning.budgets.metrics.monthlyBudget.info")} />
        <Metric label={t("planning.budgets.metrics.actualSpending.label")} value={formatMoney(spent)} tone={spent > totalBudget && totalBudget > 0 ? "negative" : "default"} info={t("planning.budgets.metrics.actualSpending.info")} />
        <Metric label={t("planning.budgets.metrics.remaining.label")} value={formatMoney(remaining)} tone={remaining >= 0 ? "positive" : "negative"} info={t("planning.budgets.metrics.remaining.info")} />
        <Metric label={t("planning.budgets.metrics.plannedAhead.label")} value={formatMoney(planned)} detail={t("planning.budgets.metrics.plannedAhead.detail")} tone="warning" info={t("planning.budgets.metrics.plannedAhead.info")} />
      </div>

      <Section title={t("planning.budgets.progress.title")} description={t("planning.budgets.progress.description")} action={overCount ? <Pill tone="negative">{t("planning.budgets.progress.overCount", { count: overCount })}</Pill> : <Pill tone="positive">{t("planning.budgets.progress.onTrack")}</Pill>}>
        <div className={ui.budgetOverall}>
          <div className={ui.budgetAmount}>
            <strong className={remaining < 0 ? ui.negative : ""}>{formatMoney(Math.abs(remaining))}</strong>
            <span>{remaining >= 0 ? t("planning.budgets.progress.leftToSpend") : t("planning.budgets.progress.overCombined")}</span>
          </div>
          <Progress value={spent} max={totalBudget || 1} label={t("planning.budgets.progress.aria", { spent: formatMoney(spent), total: formatMoney(totalBudget) })} tone={spent > totalBudget && totalBudget > 0 ? "negative" : spent / Math.max(totalBudget, 1) > .8 ? "warning" : "accent"} />
        </div>
      </Section>

      <Section title={t("planning.budgets.categories.title")} description={t("planning.budgets.categories.description")}>
        <DataState
          loading={loading}
          error={error}
          onRetry={reload}
          empty={!budgets.length}
          emptyTitle={t("planning.budgets.categories.emptyTitle")}
          emptyDescription={t("planning.budgets.categories.emptyDescription")}
          action={<AddButton onClick={() => setEditing("new")}>{t("planning.budgets.actions.addBudget")}</AddButton>}
        >
          <ResponsiveTable label={t("planning.budgets.categories.tableLabel")}>
            <thead><tr><th>{t("planning.budgets.table.category")}</th><th>{t("planning.budgets.table.monthlyLimit")}</th><th>{t("planning.budgets.table.actualSpent")}</th><th>{t("planning.budgets.table.plannedAhead")}</th><th>{t("planning.budgets.table.progress")}</th><th>{t("planning.budgets.table.remaining")}</th><th><span className="sr-only">{t("planning.shared.labels.actions")}</span></th></tr></thead>
            <tbody>
              {budgets.map((item, index) => {
                const row = readRecord(item);
                const limit = numberFrom(row.amountMinor ?? row.budgetMinor);
                const actualSpent = numberFrom(row.spentMinor ?? row.actualMinor);
                const plannedAhead = numberFrom(row.plannedMinor, plannedOccurrences.reduce((sum, item) => {
                  const occurrence = readRecord(item);
                  return sum + (String(occurrence.categoryId) === String(row.categoryId) && stringFrom(occurrence.direction ?? occurrence.type) === "expense" && !["paid", "skipped", "cancelled"].includes(stringFrom(occurrence.status)) ? reportingPlannedExpenseMinor(occurrence) : 0);
                }, 0));
                const categoryRemaining = limit - actualSpent;
                const ratio = actualSpent / Math.max(limit, 1);
                return (
                  <tr key={stringFrom(row.id, String(index))}>
                    <td className={ui.budgetCategory}><span className={ui.categoryDot} style={{ "--category-color": stringFrom(row.categoryColor, "#2563eb") } as React.CSSProperties} /><span className={`${ui.tablePrimary} ${ui.inlineTablePrimary}`}>{stringFrom(row.categoryName ?? row.category, t("planning.shared.fallback.category"))}</span>{row.parentCategoryName ? <span className={ui.tableSecondary}>{stringFrom(row.parentCategoryName)}</span> : null}</td>
                    <td className={ui.amount}>{formatMoney(limit)}</td>
                    <td className={`${ui.amount} ${ratio > 1 ? ui.negative : ""}`}>{formatMoney(actualSpent)}<small>{t("planning.budgets.table.actual")}</small></td>
                    <td className={`${ui.amount} ${ui.warning}`}>{plannedAhead ? formatMoney(plannedAhead) : t("planning.shared.labels.notAvailable")}<small>{plannedAhead ? t("planning.budgets.table.projection") : t("planning.budgets.table.none")}</small></td>
                    <td><Progress value={actualSpent} max={limit || 1} tone={ratio > 1 ? "negative" : ratio > .8 ? "warning" : "accent"} /></td>
                    <td className={`${ui.amount} ${categoryRemaining < 0 ? ui.negative : ui.positive}`}>{categoryRemaining < 0 ? "−" : ""}{formatMoney(Math.abs(categoryRemaining))}</td>
                    <td><IconButton label={t("planning.budgets.table.edit", { category: stringFrom(row.categoryName, t("planning.shared.fallback.category")) })} onClick={() => setEditing(row)}><Pencil size={15} /></IconButton></td>
                  </tr>
                );
              })}
            </tbody>
          </ResponsiveTable>
        </DataState>
      </Section>

      {overCount ? <div className={`${ui.inlineNotice} ${ui.inlineNoticeWarning}`}><AlertTriangle size={16} /><span>{t("planning.budgets.notice.overBudget", { count: overCount })}</span></div> : null}

      <BudgetForm key={`${editing === "new" ? "new" : String(editing?.id ?? "closed")}-${currency}`} entry={editing} onClose={() => setEditing(null)} onSaved={reload} month={month} currency={currency} categories={categories} budgets={budgets} />
    </Page>
  );
}

function BudgetForm({ entry, onClose, onSaved, month, currency, categories, budgets }: { entry: Row | null | "new"; onClose: () => void; onSaved: () => Promise<void>; month: string; currency: string; categories: Row[]; budgets: Row[] }) {
  const t = useTranslations();
  const translator = useTranslator();
  const record = entry === "new" || !entry ? {} : readRecord(entry);
  const [categoryId, setCategoryId] = useState(String(record.categoryId ?? ""));
  const [amount, setAmount] = useState((record.amountMinor ?? record.budgetMinor) !== undefined ? minorToInput(record.amountMinor ?? record.budgetMinor, currency) : "");
  const { submit, submitting, submitError, setSubmitError } = useSubmit(async () => {
    const amountMinor = moneyInputToMinor(amount, currency);
    if (!categoryId) throw new Error(t("planning.budgets.form.chooseCategoryError"));
    if (amountMinor === null || amountMinor <= 0) throw new Error(t("planning.budgets.form.positiveAmountError"));
    await requestJson("/api/budgets", { method: "POST", body: JSON.stringify({ id: record.id ?? null, action: record.id ? "update" : "create", month, categoryId, amountMinor }) }, translator);
    onClose();
    await onSaved();
  });
  const close = () => { setCategoryId(""); setAmount(""); setSubmitError(null); onClose(); };
  return (
    <Modal open={Boolean(entry)} onClose={close} title={record.id ? t("planning.budgets.form.editTitle") : t("planning.budgets.form.addTitle")} description={t("planning.budgets.form.description", { month })} footer={<><Button variant="ghost" onClick={close}>{t("common.actions.cancel")}</Button><Button disabled={submitting} onClick={() => void submit()}>{submitting ? t("planning.budgets.actions.saving") : t("planning.budgets.actions.saveBudget")}</Button></>}>
      <form className={ui.formGrid} onSubmit={(event) => void submit(event)}>
        <Field label={t("planning.budgets.form.category")}><Select autoFocus value={categoryId} disabled={Boolean(record.id)} onValueChange={(value) => setCategoryId(value)}><option value="">{t("planning.budgets.form.chooseCategory")}</option>{categories.filter((item) => String(readRecord(item).id) === categoryId || !budgets.some((budget) => String(readRecord(budget).categoryId) === String(readRecord(item).id))).map((item, index) => { const category = readRecord(item); return <option value={String(category.id)} key={stringFrom(category.id, String(index))}>{stringFrom(category.parentName) ? `${stringFrom(category.parentName)} › ` : ""}{stringFrom(category.name, t("planning.shared.fallback.category"))}</option>; })}</Select></Field>
        <Field label={t("planning.budgets.form.monthlyLimit", { currency })}><Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={minorToInput(0, currency)} /></Field>
        <div className={`${ui.inlineNotice} ${ui.formSpan}`}><Gauge size={16} />{t("planning.budgets.form.storageNotice")}</div>
        <button type="submit" hidden />
      </form>
      <FormMessage error={submitError} />
    </Modal>
  );
}
