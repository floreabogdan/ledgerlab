"use client";

import { AlertTriangle, Copy, Gauge, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { useDateRange } from "@/components/date-range-context";
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
      await requestJson("/api/budgets", { method: "POST", body: JSON.stringify({ action: "copy", sourceMonth: previousMonth(month), targetMonth: month, month }) });
      setMessage("Previous month’s budgets copied. Review and adjust before relying on them.");
      await reload();
    } catch (caught) { setActionError(caught instanceof Error ? caught.message : "Could not copy budgets"); }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow="Spending guardrails"
        title="Monthly budgets"
        description="Category limits compare against actual eligible spending. Upcoming planned payments remain visible but do not consume budget until paid."
        actions={<AddButton onClick={() => setEditing("new")}>Add category budget</AddButton>}
      />
      <div className={ui.toolbar}>
        <div className={ui.toolbarGroup}>
          <MonthStepper value={month} onChange={selectMonth} />
          {!rangeMatchesMonth ? <Pill tone="info">Monthly view uses the range end month</Pill> : null}
        </div>
        <Button variant="secondary" icon={<Copy size={15} />} onClick={() => void copyBudgets()}>Copy previous month</Button>
      </div>
      <FormMessage error={actionError} success={message} />

      <div className={ui.metricGrid}>
        <Metric label="Monthly budget" value={formatMoney(totalBudget)} tone="accent" info="Sum of category budgets for the selected month." />
        <Metric label="Actual spending" value={formatMoney(spent)} tone={spent > totalBudget && totalBudget > 0 ? "negative" : "default"} info="Cleared actual expenses assigned to budgeted categories; pending transactions, transfers and planned-only items are excluded." />
        <Metric label="Remaining" value={formatMoney(remaining)} tone={remaining >= 0 ? "positive" : "negative"} info="Total monthly budget minus actual eligible spending." />
        <Metric label="Planned ahead" value={formatMoney(planned)} detail="Projection only" tone="warning" info="Expected unpaid payment occurrences in budgeted categories. This does not reduce actual budget remaining." />
      </div>

      <Section title="Budget progress" description="Actual versus monthly limit" action={overCount ? <Pill tone="negative">{overCount} over budget</Pill> : <Pill tone="positive">On track</Pill>}>
        <div className={ui.budgetOverall}>
          <div className={ui.budgetAmount}>
            <strong className={remaining < 0 ? ui.negative : ""}>{formatMoney(Math.abs(remaining))}</strong>
            <span>{remaining >= 0 ? "left to spend across all categories" : "over the combined monthly budget"}</span>
          </div>
          <Progress value={spent} max={totalBudget || 1} label={`${formatMoney(spent)} spent of ${formatMoney(totalBudget)}`} tone={spent > totalBudget && totalBudget > 0 ? "negative" : spent / Math.max(totalBudget, 1) > .8 ? "warning" : "accent"} />
        </div>
      </Section>

      <Section title="Category budgets" description="Planned payments are shown separately from actual spending">
        <DataState
          loading={loading}
          error={error}
          onRetry={reload}
          empty={!budgets.length}
          emptyTitle="No budgets for this month"
          emptyDescription="Set limits for the categories you want to monitor. Transactions remain usable without budgets."
          action={<AddButton onClick={() => setEditing("new")}>Add budget</AddButton>}
        >
          <ResponsiveTable label="Monthly category budgets">
            <thead><tr><th>Category</th><th>Monthly limit</th><th>Actual spent</th><th>Planned ahead</th><th>Progress</th><th>Remaining</th><th><span className="sr-only">Actions</span></th></tr></thead>
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
                    <td className={ui.budgetCategory}><span className={ui.categoryDot} style={{ "--category-color": stringFrom(row.categoryColor, "#2563eb") } as React.CSSProperties} /><span className={`${ui.tablePrimary} ${ui.inlineTablePrimary}`}>{stringFrom(row.categoryName ?? row.category, "Category")}</span>{row.parentCategoryName ? <span className={ui.tableSecondary}>{stringFrom(row.parentCategoryName)}</span> : null}</td>
                    <td className={ui.amount}>{formatMoney(limit)}</td>
                    <td className={`${ui.amount} ${ratio > 1 ? ui.negative : ""}`}>{formatMoney(actualSpent)}<small>actual</small></td>
                    <td className={`${ui.amount} ${ui.warning}`}>{plannedAhead ? formatMoney(plannedAhead) : "—"}<small>{plannedAhead ? "projection" : "none"}</small></td>
                    <td><Progress value={actualSpent} max={limit || 1} tone={ratio > 1 ? "negative" : ratio > .8 ? "warning" : "accent"} /></td>
                    <td className={`${ui.amount} ${categoryRemaining < 0 ? ui.negative : ui.positive}`}>{categoryRemaining < 0 ? "−" : ""}{formatMoney(Math.abs(categoryRemaining))}</td>
                    <td><IconButton label={`Edit ${stringFrom(row.categoryName, "category")} budget`} onClick={() => setEditing(row)}><Pencil size={15} /></IconButton></td>
                  </tr>
                );
              })}
            </tbody>
          </ResponsiveTable>
        </DataState>
      </Section>

      {overCount ? <div className={`${ui.inlineNotice} ${ui.inlineNoticeWarning}`}><AlertTriangle size={16} /><span>{overCount} categor{overCount === 1 ? "y is" : "ies are"} over the selected monthly limit. Consider reviewing the actual transactions or adjusting a limit if the plan changed. This is a review suggestion, not financial advice.</span></div> : null}

      <BudgetForm key={`${editing === "new" ? "new" : String(editing?.id ?? "closed")}-${currency}`} entry={editing} onClose={() => setEditing(null)} onSaved={reload} month={month} currency={currency} categories={categories} budgets={budgets} />
    </Page>
  );
}

function BudgetForm({ entry, onClose, onSaved, month, currency, categories, budgets }: { entry: Row | null | "new"; onClose: () => void; onSaved: () => Promise<void>; month: string; currency: string; categories: Row[]; budgets: Row[] }) {
  const record = entry === "new" || !entry ? {} : readRecord(entry);
  const [categoryId, setCategoryId] = useState(String(record.categoryId ?? ""));
  const [amount, setAmount] = useState((record.amountMinor ?? record.budgetMinor) !== undefined ? minorToInput(record.amountMinor ?? record.budgetMinor, currency) : "");
  const { submit, submitting, submitError, setSubmitError } = useSubmit(async () => {
    const amountMinor = moneyInputToMinor(amount, currency);
    if (!categoryId) throw new Error("Choose a category.");
    if (amountMinor === null || amountMinor <= 0) throw new Error("Enter a budget greater than zero.");
    await requestJson("/api/budgets", { method: "POST", body: JSON.stringify({ id: record.id ?? null, action: record.id ? "update" : "create", month, categoryId, amountMinor }) });
    onClose();
    await onSaved();
  });
  const close = () => { setCategoryId(""); setAmount(""); setSubmitError(null); onClose(); };
  return (
    <Modal open={Boolean(entry)} onClose={close} title={record.id ? "Edit category budget" : "Add category budget"} description={`Budget for ${month}. Only actual spending consumes it.`} footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button disabled={submitting} onClick={() => void submit()}>{submitting ? "Saving…" : "Save budget"}</Button></>}>
      <form className={ui.formGrid} onSubmit={(event) => void submit(event)}>
        <Field label="Category"><Select autoFocus value={categoryId} disabled={Boolean(record.id)} onValueChange={(value) => setCategoryId(value)}><option value="">Choose category</option>{categories.filter((item) => String(readRecord(item).id) === categoryId || !budgets.some((budget) => String(readRecord(budget).categoryId) === String(readRecord(item).id))).map((item, index) => { const category = readRecord(item); return <option value={String(category.id)} key={stringFrom(category.id, String(index))}>{stringFrom(category.parentName) ? `${stringFrom(category.parentName)} › ` : ""}{stringFrom(category.name, "Category")}</option>; })}</Select></Field>
        <Field label={`Monthly limit (${currency})`}><Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={minorToInput(0, currency)} /></Field>
        <div className={`${ui.inlineNotice} ${ui.formSpan}`}><Gauge size={16} />LedgerLab stores this amount as integer minor units. It is compared with actual signed expense transactions in the category.</div>
        <button type="submit" hidden />
      </form>
      <FormMessage error={submitError} />
    </Modal>
  );
}
