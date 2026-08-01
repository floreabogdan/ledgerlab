"use client";

import { Archive, Building2, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
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
      });
      setPendingArchive(null);
      setMessage(archive ? "Merchant archived. Existing transactions still show the original merchant." : "Merchant restored.");
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not update the merchant");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow="Organisation"
        title="Merchants"
        description="Merchant records are created from actual transaction entry. Normalise their names, assign defaults, or archive them without rewriting history."
      />

      <div className={ui.metricGrid}>
        <Metric label="Active merchants" value={active.length} tone="accent" detail="Available during entry" />
        <Metric label="Transactions" value={totalTransactions} detail="Non-void actuals" />
        <Metric label="Without a default" value={withoutDefault} detail="Category chosen per entry" />
        <Metric label="Archived" value={archived.length} detail="History retained" />
      </div>

      <FormMessage error={actionError} success={message} />
      <Section title="Merchant directory" description="Default categories apply when a matching merchant is used without an explicit category.">
        <div className={`${ui.toolbar} ${ui.sectionToolbar}`}>
          <SearchField value={search} onChange={setSearch} placeholder="Search merchants or categories" />
          <Toggle
            checked={showArchived}
            onChange={setShowArchived}
            label="Show archived"
            description="Include merchants unavailable for new matching."
          />
        </div>
        <DataState
          loading={loading}
          error={error}
          onRetry={reload}
          empty={!visible.length}
          emptyTitle={search ? "No merchants match this search" : showArchived ? "No merchants yet" : "No active merchants"}
          emptyDescription={search ? "Try a different merchant or category name." : "Merchants appear automatically when you add or import actual transactions."}
        >
          <ResponsiveTable label="Merchants">
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Transactions</th>
                <th>Default category</th>
                <th>Status</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item, index) => {
                const merchant = readRecord(item);
                const archivedMerchant = isArchived(item);
                const name = stringFrom(merchant.name, "Unnamed merchant");
                return (
                  <tr key={stringFrom(merchant.id, String(index))}>
                    <td><span className={ui.tablePrimary}>{name}</span></td>
                    <td>{numberFrom(merchant.transactionCount)}</td>
                    <td>{stringFrom(merchant.defaultCategoryName, "—")}</td>
                    <td><Pill tone={archivedMerchant ? "neutral" : "info"}>{archivedMerchant ? "archived" : "active"}</Pill></td>
                    <td>
                      <div className={ui.paymentActions}>
                        <IconButton label={`Edit ${name}`} onClick={() => setEditing(item)}><Pencil size={15} /></IconButton>
                        {archivedMerchant ? (
                          <IconButton label={`Restore ${name}`} onClick={() => void changeArchiveState(item, false)}><RotateCcw size={15} /></IconButton>
                        ) : (
                          <IconButton label={`Archive ${name}`} onClick={() => setPendingArchive(item)}><Archive size={15} /></IconButton>
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
          setMessage("Merchant updated. Existing linked transactions now use the normalised name.");
          setActionError(null);
          await reload();
        }}
      />

      <Modal
        open={Boolean(pendingArchive)}
        onClose={() => setPendingArchive(null)}
        title="Archive merchant?"
        description="It will no longer be matched for new entries. Existing transactions retain their merchant history."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingArchive(null)}>Cancel</Button>
            <Button variant="danger" disabled={saving} onClick={() => pendingArchive && void changeArchiveState(pendingArchive, true)}>
              {saving ? "Archiving…" : "Archive merchant"}
            </Button>
          </>
        }
      >
        <div className={ui.inlineNotice}>
          <Building2 size={17} aria-hidden="true" />
          <span><strong>{stringFrom(readRecord(pendingArchive).name, "This merchant")}</strong> remains visible on its existing transactions and reports.</span>
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
    if (!name.trim()) throw new Error("Enter a merchant name.");
    await requestJson("/api/merchants", {
      method: "POST",
      body: JSON.stringify({ action: "update", id: record.id, name: name.trim(), defaultCategoryId: defaultCategoryId || null }),
    });
    onClose();
    await onSaved();
  });

  return (
    <Modal
      open={Boolean(merchant)}
      onClose={() => { setSubmitError(null); onClose(); }}
      title="Edit merchant"
      description="Renaming normalises every linked view without changing the original transaction amounts or dates."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={submitting} onClick={() => void submit()}>{submitting ? "Saving…" : "Save changes"}</Button>
        </>
      }
    >
      <form className={ui.formGrid} onSubmit={(event) => void submit(event)}>
        <Field label="Merchant name" className={ui.formSpan}>
          <Input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Default category" hint="Used only when an entry has no explicit category." className={ui.formSpan}>
          <Select value={defaultCategoryId} onValueChange={(value) => setDefaultCategoryId(value)}>
            <option value="">No default category</option>
            {categories.map((item, index) => {
              const category = readRecord(item);
              const label = category.parentName ? `${stringFrom(category.parentName)} / ${stringFrom(category.name)}` : stringFrom(category.name, "Category");
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
