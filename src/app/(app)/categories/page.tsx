"use client";

import { Archive, CornerDownRight, FolderTree, Pencil, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslations, useTranslator } from "@/i18n/client";
import {
  AddButton,
  Button,
  DataState,
  Field,
  FormMessage,
  IconButton,
  Input,
  Metric,
  Modal,
  Page,
  Pill,
  readList,
  readRecord,
  requestJson,
  ResponsiveTable,
  Section,
  Select,
  stringFrom,
  Toggle,
  useJson,
  useSubmit,
  ViewHeader,
} from "../_components/feature-kit";
import ui from "../_components/pages.module.css";
import styles from "./categories.module.css";

type Category = Record<string, unknown>;
type CategoryEntry = Category | "new" | null;
type CategoryKind = "income" | "expense" | "both";
type Translate = ReturnType<typeof useTranslations>;

function isArchived(category: Category) {
  return Boolean(readRecord(category).archivedAt ?? readRecord(category).isArchived);
}

function categoryDepth(category: Category) {
  const row = readRecord(category);
  const depth = Number(row.depth);
  return Number.isSafeInteger(depth) && depth >= 0 ? depth : row.parentId ? 1 : 0;
}

function categoryPath(category: Category, t: Translate) {
  const row = readRecord(category);
  return stringFrom(row.path, stringFrom(row.parentName)
    ? `${stringFrom(row.parentName)} › ${stringFrom(row.name, t("entities.shared.fallback.category"))}`
    : stringFrom(row.name, t("entities.shared.fallback.category")));
}

function parentPath(category: Category, t: Translate) {
  const path = categoryPath(category, t).split(" › ");
  return path.length > 1 ? path.slice(0, -1).join(" › ") : t("entities.categories.hierarchy.topLevel");
}

function ancestorIds(category: Category) {
  const value = readRecord(category).ancestorIds;
  return Array.isArray(value) ? value.map(String) : [];
}

function kindsAreCompatible(parentKind: string, childKind: string) {
  return parentKind === "both" || parentKind === childKind;
}

function categoryKindLabel(value: string, t: Translate) {
  if (value === "income") return t("entities.categories.kind.income");
  if (value === "both") return t("entities.categories.kind.both");
  return t("entities.categories.kind.expense");
}

function spendingNatureLabel(value: string, t: Translate) {
  return value === "fixed"
    ? t("entities.categories.spendingNature.fixed")
    : t("entities.categories.spendingNature.variable");
}

function spendingPriorityLabel(value: string, t: Translate) {
  return value === "essential"
    ? t("entities.categories.spendingPriority.essential")
    : t("entities.categories.spendingPriority.discretionary");
}

export default function CategoriesPage() {
  const t = useTranslations();
  const translator = useTranslator();
  const { data: raw, loading, error, reload } = useJson<Record<string, unknown>>("/api/categories?archived=all", {});
  const categories = readList<Category>(raw, "categories");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<CategoryEntry>(null);
  const [pendingArchive, setPendingArchive] = useState<Category | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const active = categories.filter((category) => !isArchived(category));
  const archived = categories.filter(isArchived);
  const visible = categories.filter((category) => showArchived || !isArchived(category));
  const parentCount = active.filter((category) => categoryDepth(category) === 0).length;
  const subcategoryCount = active.length - parentCount;

  async function changeArchiveState(category: Category, archive: boolean) {
    setSaving(true);
    setActionError(null);
    setMessage(null);
    try {
      await requestJson("/api/categories", {
        method: "POST",
        body: JSON.stringify({ action: archive ? "archive" : "restore", id: readRecord(category).id }),
      }, translator);
      setPendingArchive(null);
      setMessage(archive ? t("entities.categories.feedback.archived") : t("entities.categories.feedback.restored"));
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : t("entities.categories.feedback.updateFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow={t("entities.shared.eyebrow")}
        title={t("entities.categories.header.title")}
        description={t("entities.categories.header.description")}
        actions={<AddButton onClick={() => setEditing("new")}>{t("entities.categories.actions.add")}</AddButton>}
      />

      <div className={ui.metricGrid}>
        <Metric label={t("entities.categories.metrics.active.label")} value={active.length} detail={t("entities.categories.metrics.active.detail")} tone="accent" />
        <Metric label={t("entities.categories.metrics.roots.label")} value={parentCount} detail={t("entities.categories.metrics.roots.detail")} />
        <Metric label={t("entities.categories.metrics.nested.label")} value={subcategoryCount} detail={t("entities.categories.metrics.nested.detail")} />
        <Metric label={t("entities.categories.metrics.archived.label")} value={archived.length} detail={t("entities.categories.metrics.archived.detail")} />
      </div>

      <FormMessage error={actionError} success={message} />
      <Section
        title={t("entities.categories.section.title")}
        description={t("entities.categories.section.description")}
        action={
          <Toggle
            checked={showArchived}
            onChange={setShowArchived}
            label={t("entities.categories.toggle.label")}
            description={t("entities.categories.toggle.description")}
          />
        }
      >
        <DataState
          loading={loading}
          error={error}
          onRetry={reload}
          empty={!visible.length}
          emptyTitle={showArchived ? t("entities.categories.empty.allTitle") : t("entities.categories.empty.activeTitle")}
          emptyDescription={t("entities.categories.empty.description")}
          action={<AddButton onClick={() => setEditing("new")}>{t("entities.categories.actions.add")}</AddButton>}
        >
          <ResponsiveTable label={t("entities.categories.table.label")}>
            <thead>
              <tr>
                <th>{t("entities.categories.table.category")}</th>
                <th>{t("entities.categories.table.type")}</th>
                <th>{t("entities.categories.table.spendingPattern")}</th>
                <th>{t("entities.categories.table.priority")}</th>
                <th>{t("entities.categories.table.status")}</th>
                <th><span className="sr-only">{t("entities.shared.table.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item, index) => {
                const category = readRecord(item);
                const id = stringFrom(category.id, String(index));
                const depth = categoryDepth(item);
                const archivedCategory = isArchived(item);
                const directChildren = active.filter((candidate) => stringFrom(readRecord(candidate).parentId) === id).length;
                return (
                  <tr className={depth === 0 ? styles.rootRow : styles.childRow} key={id}>
                    <td className={styles.categoryCell}>
                      <div
                        className={styles.treeItem}
                        style={{ "--category-depth": depth } as React.CSSProperties}
                      >
                        <span className={styles.treeMarker} aria-hidden="true">
                          {depth ? <CornerDownRight size={15} /> : <FolderTree size={16} />}
                        </span>
                        <span className={styles.categoryCopy}>
                          <span className={ui.tablePrimary}>
                            <span
                              className={ui.categoryDot}
                              style={{ "--category-color": stringFrom(category.color, "#2563eb") } as React.CSSProperties}
                            />
                            {stringFrom(category.name, t("entities.shared.fallback.unnamedCategory"))}
                          </span>
                          <span className={ui.tableSecondary}>
                            {depth
                              ? t("entities.categories.hierarchy.under", { parent: parentPath(item, t) })
                              : directChildren
                                ? t("entities.categories.hierarchy.directSubcategories", { count: directChildren })
                                : t("entities.categories.hierarchy.topLevel")}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td><Pill tone={stringFrom(category.kind) === "income" ? "positive" : "neutral"}>{categoryKindLabel(stringFrom(category.kind, "expense"), t)}</Pill></td>
                    <td><Pill tone={stringFrom(category.spendingNature ?? category.spendingType) === "fixed" ? "info" : "neutral"}>{spendingNatureLabel(stringFrom(category.spendingNature ?? category.spendingType, "variable"), t)}</Pill></td>
                    <td>{spendingPriorityLabel(stringFrom(category.spendingPriority, category.essential === true ? "essential" : "discretionary"), t)}</td>
                    <td><Pill tone={archivedCategory ? "neutral" : "info"}>{archivedCategory ? t("entities.shared.status.archived") : t("entities.shared.status.active")}</Pill></td>
                    <td>
                      <div className={styles.actions}>
                        <IconButton label={t("entities.categories.actions.editNamed", { name: stringFrom(category.name, t("entities.shared.fallback.category")) })} onClick={() => setEditing(item)}>
                          <Pencil size={15} />
                        </IconButton>
                        {archivedCategory ? (
                          <IconButton label={t("entities.categories.actions.restoreNamed", { name: stringFrom(category.name, t("entities.shared.fallback.category")) })} onClick={() => void changeArchiveState(item, false)}>
                            <RotateCcw size={15} />
                          </IconButton>
                        ) : (
                          <IconButton label={t("entities.categories.actions.archiveNamed", { name: stringFrom(category.name, t("entities.shared.fallback.category")) })} onClick={() => setPendingArchive(item)}>
                            <Archive size={15} />
                          </IconButton>
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

      <CategoryForm
        key={editing === "new" ? "category-form-new" : `category-form-${stringFrom(readRecord(editing).id, "closed")}`}
        entry={editing}
        onClose={() => setEditing(null)}
        categories={categories}
        onSaved={async (updated) => {
          setMessage(updated ? t("entities.categories.feedback.updated") : t("entities.categories.feedback.created"));
          setActionError(null);
          await reload();
        }}
      />

      <Modal
        open={Boolean(pendingArchive)}
        onClose={() => setPendingArchive(null)}
        title={t("entities.categories.archive.title")}
        description={t("entities.categories.archive.description")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingArchive(null)}>{t("common.actions.cancel")}</Button>
            <Button variant="danger" disabled={saving} onClick={() => pendingArchive && void changeArchiveState(pendingArchive, true)}>
              {saving ? t("entities.categories.actions.archiving") : t("entities.categories.archive.confirm")}
            </Button>
          </>
        }
      >
        <div className={ui.inlineNotice}>
          <FolderTree size={17} aria-hidden="true" />
          <span>{t("entities.categories.archive.notice", { name: stringFrom(readRecord(pendingArchive).name, t("entities.shared.fallback.thisCategory")) })}</span>
        </div>
      </Modal>
    </Page>
  );
}

function CategoryForm({
  entry,
  onClose,
  categories,
  onSaved,
}: {
  entry: CategoryEntry;
  onClose: () => void;
  categories: Category[];
  onSaved: (updated: boolean) => Promise<void>;
}) {
  const t = useTranslations();
  const translator = useTranslator();
  const record = entry === "new" || !entry ? {} : readRecord(entry);
  const categoryId = stringFrom(record.id);
  const editing = Boolean(categoryId);
  const [name, setName] = useState(stringFrom(record.name));
  const [parentId, setParentId] = useState(stringFrom(record.parentId));
  const [kind, setKind] = useState<CategoryKind>((stringFrom(record.kind, "expense") as CategoryKind));
  const [spendingNature, setSpendingNature] = useState(stringFrom(record.spendingNature ?? record.spendingType, "variable"));
  const [spendingPriority, setSpendingPriority] = useState(stringFrom(record.spendingPriority, record.essential === true ? "essential" : "discretionary"));
  const [color, setColor] = useState(stringFrom(record.color, "#2563eb"));
  const descendants = new Set(categories.filter((category) => ancestorIds(category).includes(categoryId)).map((category) => stringFrom(readRecord(category).id)));
  const parentOptions = categories.filter((category) => {
    const row = readRecord(category);
    const id = stringFrom(row.id);
    return !isArchived(category)
      && id !== categoryId
      && !descendants.has(id)
      && kindsAreCompatible(stringFrom(row.kind, "expense"), kind);
  });
  const hasChildren = Boolean(record.hasChildren) || categories.some((category) => stringFrom(readRecord(category).parentId) === categoryId);
  const { submit, submitting, submitError, setSubmitError } = useSubmit(async () => {
    if (!name.trim()) throw new Error(t("entities.categories.form.nameRequired"));
    await requestJson("/api/categories", {
      method: "POST",
      body: JSON.stringify({
        action: editing ? "update" : "create",
        id: editing ? categoryId : undefined,
        name: name.trim(),
        parentId: parentId || null,
        kind,
        spendingNature,
        spendingPriority,
        color,
      }),
    }, translator);
    onClose();
    await onSaved(editing);
  });

  const close = () => {
    setSubmitError(null);
    onClose();
  };

  return (
    <Modal
      open={Boolean(entry)}
      onClose={close}
      title={editing ? t("entities.categories.form.editTitle") : t("entities.categories.form.addTitle")}
      description={editing ? t("entities.categories.form.editDescription", { path: categoryPath(record, t) }) : t("entities.categories.form.addDescription")}
      footer={
        <>
          <Button variant="ghost" onClick={close}>{t("common.actions.cancel")}</Button>
          <Button disabled={submitting} onClick={() => void submit()}>{submitting ? t("entities.categories.actions.saving") : editing ? t("entities.categories.actions.saveChanges") : t("entities.categories.actions.create")}</Button>
        </>
      }
    >
      <form className={ui.formGrid} onSubmit={(event) => void submit(event)}>
        <Field label={t("entities.categories.form.name")} className={ui.formSpan}>
          <Input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder={t("entities.categories.form.namePlaceholder")} />
        </Field>
        <Field label={t("entities.categories.form.parent")} hint={t("entities.categories.form.parentHint")}>
          <Select searchable value={parentId} onValueChange={setParentId} searchPlaceholder={t("entities.categories.form.parentSearchPlaceholder")}>
            <option value="">{t("entities.categories.form.noParent")}</option>
            {parentOptions.map((item, index) => {
              const category = readRecord(item);
              return <option value={stringFrom(category.id)} key={stringFrom(category.id, String(index))}>{categoryPath(item, t)}</option>;
            })}
          </Select>
        </Field>
        <Field label={t("entities.categories.form.categoryType")} hint={hasChildren ? t("entities.categories.form.categoryTypeChildrenHint") : undefined}>
          <Select value={kind} onValueChange={(value) => {
            const nextKind = value as CategoryKind;
            setKind(nextKind);
            const parent = categories.find((category) => stringFrom(readRecord(category).id) === parentId);
            if (parent && !kindsAreCompatible(stringFrom(readRecord(parent).kind, "expense"), nextKind)) setParentId("");
          }}>
            <option value="expense">{t("entities.categories.kind.expense")}</option>
            <option value="income">{t("entities.categories.kind.income")}</option>
            <option value="both">{t("entities.categories.kind.both")}</option>
          </Select>
        </Field>
        <Field label={t("entities.categories.form.spendingPattern")}>
          <Select value={spendingNature} onValueChange={setSpendingNature}>
            <option value="variable">{t("entities.categories.spendingNature.variable")}</option>
            <option value="fixed">{t("entities.categories.spendingNature.fixed")}</option>
          </Select>
        </Field>
        <Field label={t("entities.categories.form.priority")}>
          <Select value={spendingPriority} onValueChange={setSpendingPriority}>
            <option value="discretionary">{t("entities.categories.spendingPriority.discretionary")}</option>
            <option value="essential">{t("entities.categories.spendingPriority.essential")}</option>
          </Select>
        </Field>
        <Field htmlFor="category-colour" label={t("entities.categories.form.colour")} className={ui.formSpan}>
          <input id="category-colour" className={ui.colorInput} type="color" value={color} onChange={(event) => setColor(event.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
      <FormMessage error={submitError} />
    </Modal>
  );
}
