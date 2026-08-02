"use client";

import { Archive, Building2, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations, useTranslator } from "@/i18n/client";
import {
  Button,
  DataState,
  Field,
  FormMessage,
  IconButton,
  Input,
  Metric,
  Modal,
  numberFrom,
  Page,
  Pill,
  readList,
  readRecord,
  requestJson,
  ResponsiveTable,
  SearchField,
  Section,
  Select,
  stringFrom,
  Toggle,
  useJson,
  useSubmit,
  ViewHeader,
} from "../_components/feature-kit";
import ui from "../_components/pages.module.css";

type Merchant = Record<string, unknown>;
type Category = Record<string, unknown>;

function isArchived(merchant: Merchant) {
  return Boolean(readRecord(merchant).archivedAt ?? readRecord(merchant).isArchived);
}

export default function MerchantsPage() {
  const t = useTranslations();
  const translator = useTranslator();
  const { data: raw, loading, error, reload } = useJson<Record<string, unknown>>("/api/merchants?archived=all", {});
  const merchants = readList<Merchant>(raw, "merchants");
  const categories = readList<Category>(raw, "categories");
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Merchant | null>(null);
  const [pendingArchive, setPendingArchive] = useState<Merchant | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const active = merchants.filter((merchant) => !isArchived(merchant));
  const archived = merchants.filter(isArchived);
  const totalTransactions = active.reduce((sum, merchant) => sum + numberFrom(readRecord(merchant).transactionCount), 0);
  const withoutDefault = active.filter((merchant) => !readRecord(merchant).defaultCategoryId).length;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visible = merchants.filter((item) => {
    const merchant = readRecord(item);
    if (!showArchived && isArchived(item)) return false;
    return !normalizedSearch || stringFrom(merchant.name).toLocaleLowerCase().includes(normalizedSearch) ||
      stringFrom(merchant.defaultCategoryName).toLocaleLowerCase().includes(normalizedSearch);
  });

  async function changeArchiveState(merchant: Merchant, archive: boolean) {
    setSaving(true);
    setActionError(null);
    setMessage(null);
    try {
      await requestJson("/api/merchants", {
        method: "POST",
        body: JSON.stringify({ action: archive ? "archive" : "restore", id: readRecord(merchant).id }),
      }, translator);
      setPendingArchive(null);
      setMessage(archive ? t("entities.merchants.feedback.archived") : t("entities.merchants.feedback.restored"));
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : t("entities.merchants.feedback.updateFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow={t("entities.shared.eyebrow")}
        title={t("entities.merchants.header.title")}
        description={t("entities.merchants.header.description")}
      />

      <div className={ui.metricGrid}>
        <Metric label={t("entities.merchants.metrics.active.label")} value={active.length} tone="accent" detail={t("entities.merchants.metrics.active.detail")} />
        <Metric label={t("entities.merchants.metrics.transactions.label")} value={totalTransactions} detail={t("entities.merchants.metrics.transactions.detail")} />
        <Metric label={t("entities.merchants.metrics.noDefault.label")} value={withoutDefault} detail={t("entities.merchants.metrics.noDefault.detail")} />
        <Metric label={t("entities.merchants.metrics.archived.label")} value={archived.length} detail={t("entities.merchants.metrics.archived.detail")} />
      </div>

      <FormMessage error={actionError} success={message} />
      <Section title={t("entities.merchants.section.title")} description={t("entities.merchants.section.description")}>
        <div className={`${ui.toolbar} ${ui.sectionToolbar}`}>
          <SearchField value={search} onChange={setSearch} placeholder={t("entities.merchants.search.placeholder")} />
          <Toggle
            checked={showArchived}
            onChange={setShowArchived}
            label={t("entities.merchants.toggle.label")}
            description={t("entities.merchants.toggle.description")}
          />
        </div>
        <DataState
          loading={loading}
          error={error}
          onRetry={reload}
          empty={!visible.length}
          emptyTitle={search ? t("entities.merchants.search.noMatchesTitle") : showArchived ? t("entities.merchants.empty.allTitle") : t("entities.merchants.empty.activeTitle")}
          emptyDescription={search ? t("entities.merchants.search.noMatchesDescription") : t("entities.merchants.empty.description")}
        >
          <ResponsiveTable label={t("entities.merchants.table.label")}>
            <thead>
              <tr>
                <th>{t("entities.merchants.table.merchant")}</th>
                <th>{t("entities.merchants.table.transactions")}</th>
                <th>{t("entities.merchants.table.defaultCategory")}</th>
                <th>{t("entities.merchants.table.status")}</th>
                <th><span className="sr-only">{t("entities.shared.table.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item, index) => {
                const merchant = readRecord(item);
                const archivedMerchant = isArchived(item);
                const name = stringFrom(merchant.name, t("entities.shared.fallback.unnamedMerchant"));
                return (
                  <tr key={stringFrom(merchant.id, String(index))}>
                    <td><span className={ui.tablePrimary}>{name}</span></td>
                    <td>{numberFrom(merchant.transactionCount)}</td>
                    <td>{stringFrom(merchant.defaultCategoryName, "—")}</td>
                    <td><Pill tone={archivedMerchant ? "neutral" : "info"}>{archivedMerchant ? t("entities.shared.status.archived") : t("entities.shared.status.active")}</Pill></td>
                    <td>
                      <div className={ui.paymentActions}>
                        <IconButton label={t("entities.merchants.actions.editNamed", { name })} onClick={() => setEditing(item)}><Pencil size={15} /></IconButton>
                        {archivedMerchant ? (
                          <IconButton label={t("entities.merchants.actions.restoreNamed", { name })} onClick={() => void changeArchiveState(item, false)}><RotateCcw size={15} /></IconButton>
                        ) : (
                          <IconButton label={t("entities.merchants.actions.archiveNamed", { name })} onClick={() => setPendingArchive(item)}><Archive size={15} /></IconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </ResponsiveTable>
        </DataState>
      </Section>

      <MerchantForm
        merchant={editing}
        categories={categories}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setMessage(t("entities.merchants.feedback.updated"));
          setActionError(null);
          await reload();
        }}
      />

      <Modal
        open={Boolean(pendingArchive)}
        onClose={() => setPendingArchive(null)}
        title={t("entities.merchants.archive.title")}
        description={t("entities.merchants.archive.description")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingArchive(null)}>{t("common.actions.cancel")}</Button>
            <Button variant="danger" disabled={saving} onClick={() => pendingArchive && void changeArchiveState(pendingArchive, true)}>
              {saving ? t("entities.merchants.actions.archiving") : t("entities.merchants.archive.confirm")}
            </Button>
          </>
        }
      >
        <div className={ui.inlineNotice}>
          <Building2 size={17} aria-hidden="true" />
          <span>{t("entities.merchants.archive.notice", { name: stringFrom(readRecord(pendingArchive).name, t("entities.shared.fallback.thisMerchant")) })}</span>
        </div>
      </Modal>
    </Page>
  );
}

function MerchantForm({
  merchant,
  categories,
  onClose,
  onSaved,
}: {
  merchant: Merchant | null;
  categories: Category[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations();
  const translator = useTranslator();
  const record = readRecord(merchant);
  const [name, setName] = useState("");
  const [defaultCategoryId, setDefaultCategoryId] = useState("");

  useEffect(() => {
    queueMicrotask(() => {
      setName(stringFrom(record.name));
      setDefaultCategoryId(stringFrom(record.defaultCategoryId));
    });
  }, [record.defaultCategoryId, record.name]);

  const { submit, submitting, submitError, setSubmitError } = useSubmit(async () => {
    if (!name.trim()) throw new Error(t("entities.merchants.form.nameRequired"));
    await requestJson("/api/merchants", {
      method: "POST",
      body: JSON.stringify({ action: "update", id: record.id, name: name.trim(), defaultCategoryId: defaultCategoryId || null }),
    }, translator);
    onClose();
    await onSaved();
  });

  return (
    <Modal
      open={Boolean(merchant)}
      onClose={() => { setSubmitError(null); onClose(); }}
      title={t("entities.merchants.form.title")}
      description={t("entities.merchants.form.description")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("common.actions.cancel")}</Button>
          <Button disabled={submitting} onClick={() => void submit()}>{submitting ? t("entities.merchants.actions.saving") : t("entities.merchants.actions.saveChanges")}</Button>
        </>
      }
    >
      <form className={ui.formGrid} onSubmit={(event) => void submit(event)}>
        <Field label={t("entities.merchants.form.name")} className={ui.formSpan}>
          <Input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t("entities.merchants.form.defaultCategory")} hint={t("entities.merchants.form.defaultCategoryHint")} className={ui.formSpan}>
          <Select value={defaultCategoryId} onValueChange={(value) => setDefaultCategoryId(value)}>
            <option value="">{t("entities.merchants.form.noDefaultCategory")}</option>
            {categories.map((item, index) => {
              const category = readRecord(item);
              const label = category.parentName ? `${stringFrom(category.parentName)} / ${stringFrom(category.name)}` : stringFrom(category.name, t("entities.shared.fallback.category"));
              return <option value={stringFrom(category.id)} key={stringFrom(category.id, String(index))}>{label}</option>;
            })}
          </Select>
        </Field>
        <button type="submit" hidden />
      </form>
      <FormMessage error={submitError} />
    </Modal>
  );
}
