"use client";

import { Archive, CornerDownRight, FolderTree, Pencil, RotateCcw } from "lucide-react";
import { useState } from "react";
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

function isArchived(category: Category) {
  return Boolean(readRecord(category).archivedAt ?? readRecord(category).isArchived);
}

function categoryDepth(category: Category) {
  const row = readRecord(category);
  const depth = Number(row.depth);
  return Number.isSafeInteger(depth) && depth >= 0 ? depth : row.parentId ? 1 : 0;
}

function categoryPath(category: Category) {
  const row = readRecord(category);
  return stringFrom(row.path, stringFrom(row.parentName)
    ? `${stringFrom(row.parentName)} › ${stringFrom(row.name, "Category")}`
    : stringFrom(row.name, "Category"));
}

function parentPath(category: Category) {
  const path = categoryPath(category).split(" › ");
  return path.length > 1 ? path.slice(0, -1).join(" › ") : "Top level";
}

function ancestorIds(category: Category) {
  const value = readRecord(category).ancestorIds;
  return Array.isArray(value) ? value.map(String) : [];
}

function kindsAreCompatible(parentKind: string, childKind: string) {
  return parentKind === "both" || parentKind === childKind;
}

export default function CategoriesPage() {
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
      });
      setPendingArchive(null);
      setMessage(archive ? "Category archived. Historical transactions and reports were preserved." : "Category restored.");
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not update the category");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow="Organisation"
        title="Categories"
        description="Build a clear income and spending hierarchy for entry, budgets and reporting. Archiving never rewrites history."
        actions={<AddButton onClick={() => setEditing("new")}>Add category</AddButton>}
      />

      <div className={ui.metricGrid}>
        <Metric label="Active categories" value={active.length} detail="Available for new entries" tone="accent" />
        <Metric label="Top-level groups" value={parentCount} detail="Hierarchy roots" />
        <Metric label="Nested categories" value={subcategoryCount} detail="Across every depth" />
        <Metric label="Archived" value={archived.length} detail="History retained" />
      </div>

      <FormMessage error={actionError} success={message} />
      <Section
        title="Category hierarchy"
        description="Indentation shows parentage; fixed/variable and essential/discretionary classifications feed planning and statistics."
        action={
          <Toggle
            checked={showArchived}
            onChange={setShowArchived}
            label="Show archived"
            description="Include categories unavailable for new entries."
          />
        }
      >
        <DataState
          loading={loading}
          error={error}
          onRetry={reload}
          empty={!visible.length}
          emptyTitle={showArchived ? "No categories yet" : "No active categories"}
          emptyDescription="Add a top-level category or nest one beneath any compatible category."
          action={<AddButton onClick={() => setEditing("new")}>Add category</AddButton>}
        >
          <ResponsiveTable label="Category hierarchy">
            <thead>
              <tr>
                <th>Category</th>
                <th>Type</th>
                <th>Spending pattern</th>
                <th>Priority</th>
                <th>Status</th>
                <th><span className="sr-only">Actions</span></th>
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
                            {stringFrom(category.name, "Unnamed category")}
                          </span>
                          <span className={ui.tableSecondary}>
                            {depth ? `Under ${parentPath(item)}` : directChildren ? `${directChildren} direct subcategor${directChildren === 1 ? "y" : "ies"}` : "Top level"}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td><Pill tone={stringFrom(category.kind) === "income" ? "positive" : "neutral"}>{stringFrom(category.kind, "expense")}</Pill></td>
                    <td><Pill tone={stringFrom(category.spendingNature ?? category.spendingType) === "fixed" ? "info" : "neutral"}>{stringFrom(category.spendingNature ?? category.spendingType, "variable")}</Pill></td>
                    <td className={ui.capitalize}>{stringFrom(category.spendingPriority, category.essential === true ? "essential" : "discretionary")}</td>
                    <td><Pill tone={archivedCategory ? "neutral" : "info"}>{archivedCategory ? "archived" : "active"}</Pill></td>
                    <td>
                      <div className={styles.actions}>
                        <IconButton label={`Edit ${stringFrom(category.name, "category")}`} onClick={() => setEditing(item)}>
                          <Pencil size={15} />
                        </IconButton>
                        {archivedCategory ? (
                          <IconButton label={`Restore ${stringFrom(category.name, "category")}`} onClick={() => void changeArchiveState(item, false)}>
                            <RotateCcw size={15} />
                          </IconButton>
                        ) : (
                          <IconButton label={`Archive ${stringFrom(category.name, "category")}`} onClick={() => setPendingArchive(item)}>
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
          setMessage(updated ? "Category updated." : "Category created.");
          setActionError(null);
          await reload();
        }}
      />

      <Modal
        open={Boolean(pendingArchive)}
        onClose={() => setPendingArchive(null)}
        title="Archive category?"
        description="It will no longer be offered for new transactions or budgets. Existing history remains unchanged."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingArchive(null)}>Cancel</Button>
            <Button variant="danger" disabled={saving} onClick={() => pendingArchive && void changeArchiveState(pendingArchive, true)}>
              {saving ? "Archiving…" : "Archive category"}
            </Button>
          </>
        }
      >
        <div className={ui.inlineNotice}>
          <FolderTree size={17} aria-hidden="true" />
          <span><strong>{stringFrom(readRecord(pendingArchive).name, "This category")}</strong> will remain attached to every historical transaction. Active descendants must be moved or archived first.</span>
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
    if (!name.trim()) throw new Error("Enter a category name.");
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
    });
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
      title={editing ? "Edit category" : "Add category"}
      description={editing ? `Update ${categoryPath(record)} without changing historical assignments.` : "Create a top-level category or nest it beneath a compatible parent."}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button disabled={submitting} onClick={() => void submit()}>{submitting ? "Saving…" : editing ? "Save changes" : "Create category"}</Button>
        </>
      }
    >
      <form className={ui.formGrid} onSubmit={(event) => void submit(event)}>
        <Field label="Name" className={ui.formSpan}>
          <Input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="e.g. Home maintenance" />
        </Field>
        <Field label="Parent category" hint="Choose any active parent with a compatible type, or leave this at top level.">
          <Select searchable value={parentId} onValueChange={setParentId} searchPlaceholder="Search the hierarchy">
            <option value="">None — top level</option>
            {parentOptions.map((item, index) => {
              const category = readRecord(item);
              return <option value={stringFrom(category.id)} key={stringFrom(category.id, String(index))}>{categoryPath(item)}</option>;
            })}
          </Select>
        </Field>
        <Field label="Category type" hint={hasChildren ? "The server will preserve type compatibility across descendants." : undefined}>
          <Select value={kind} onValueChange={(value) => {
            const nextKind = value as CategoryKind;
            setKind(nextKind);
            const parent = categories.find((category) => stringFrom(readRecord(category).id) === parentId);
            if (parent && !kindsAreCompatible(stringFrom(readRecord(parent).kind, "expense"), nextKind)) setParentId("");
          }}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
            <option value="both">Income and expense</option>
          </Select>
        </Field>
        <Field label="Spending pattern">
          <Select value={spendingNature} onValueChange={setSpendingNature}>
            <option value="variable">Variable</option>
            <option value="fixed">Fixed</option>
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={spendingPriority} onValueChange={setSpendingPriority}>
            <option value="discretionary">Discretionary</option>
            <option value="essential">Essential</option>
          </Select>
        </Field>
        <Field htmlFor="category-colour" label="Colour" className={ui.formSpan}>
          <input id="category-colour" className={ui.colorInput} type="color" value={color} onChange={(event) => setColor(event.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
      <FormMessage error={submitError} />
    </Modal>
  );
}
