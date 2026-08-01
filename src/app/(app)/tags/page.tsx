"use client";

import { Archive, Pencil, RotateCcw, Tag as TagIcon } from "lucide-react";
import { useEffect, useState } from "react";
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
  numberFrom,
  Page,
  Pill,
  readList,
  readRecord,
  requestJson,
  ResponsiveTable,
  Section,
  stringFrom,
  Toggle,
  useJson,
  useSubmit,
  ViewHeader,
} from "../_components/feature-kit";
import ui from "../_components/pages.module.css";

type Tag = Record<string, unknown>;

function isArchived(tag: Tag) {
  return Boolean(readRecord(tag).archivedAt ?? readRecord(tag).isArchived);
}

export default function TagsPage() {
  const { data: raw, loading, error, reload } = useJson<Record<string, unknown>>("/api/tags?archived=all", {});
  const tags = readList<Tag>(raw, "tags");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Tag | "new" | null>(null);
  const [pendingArchive, setPendingArchive] = useState<Tag | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const active = tags.filter((tag) => !isArchived(tag));
  const archived = tags.filter(isArchived);
  const visible = tags.filter((tag) => showArchived || !isArchived(tag));
  const totalUses = active.reduce((sum, tag) => sum + numberFrom(readRecord(tag).usageCount), 0);
  const unused = active.filter((tag) => numberFrom(readRecord(tag).usageCount) === 0).length;

  async function changeArchiveState(tag: Tag, archive: boolean) {
    setSaving(true);
    setActionError(null);
    setMessage(null);
    try {
      await requestJson("/api/tags", {
        method: "POST",
        body: JSON.stringify({ action: archive ? "archive" : "restore", id: readRecord(tag).id }),
      });
      setPendingArchive(null);
      setMessage(archive ? "Tag archived. Existing transaction links were preserved." : "Tag restored.");
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not update the tag");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow="Organisation"
        title="Tags"
        description="Use flexible labels across categories and accounts. Renaming or archiving a tag preserves every existing transaction link."
        actions={<AddButton onClick={() => setEditing("new")}>Add tag</AddButton>}
      />

      <div className={ui.metricGrid}>
        <Metric label="Active tags" value={active.length} tone="accent" detail="Available during entry" />
        <Metric label="Transaction links" value={totalUses} detail="Across active tags" />
        <Metric label="Unused tags" value={unused} detail="Candidates to review" />
        <Metric label="Archived" value={archived.length} detail="Links retained" />
      </div>

      <FormMessage error={actionError} success={message} />
      <Section
        title="Tag library"
        description="Usage counts exclude voided transactions."
        action={
          <Toggle
            checked={showArchived}
            onChange={setShowArchived}
            label="Show archived"
            description="Include tags unavailable for new entries."
          />
        }
      >
        <DataState
          loading={loading}
          error={error}
          onRetry={reload}
          empty={!visible.length}
          emptyTitle={showArchived ? "No tags yet" : "No active tags"}
          emptyDescription="Create a tag when you need a label that cuts across categories, merchants, or accounts."
          action={<AddButton onClick={() => setEditing("new")}>Add tag</AddButton>}
        >
          <ResponsiveTable label="Tags">
            <thead>
              <tr>
                <th>Tag</th>
                <th>Transactions</th>
                <th>Status</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item, index) => {
                const tag = readRecord(item);
                const archivedTag = isArchived(item);
                const name = stringFrom(tag.name, "Unnamed tag");
                return (
                  <tr key={stringFrom(tag.id, String(index))}>
                    <td>
                      <span className={ui.tablePrimary}>
                        <span
                          className={ui.categoryDot}
                          style={{ "--category-color": stringFrom(tag.color, "#2563eb") } as React.CSSProperties}
                        />
                        {name}
                      </span>
                    </td>
                    <td>{numberFrom(tag.usageCount)}</td>
                    <td><Pill tone={archivedTag ? "neutral" : "info"}>{archivedTag ? "archived" : "active"}</Pill></td>
                    <td>
                      <div className={ui.paymentActions}>
                        <IconButton label={`Rename ${name}`} onClick={() => setEditing(item)}><Pencil size={15} /></IconButton>
                        {archivedTag ? (
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

      <TagForm
        key={editing === "new" ? "tag-new" : editing ? `tag-${stringFrom(readRecord(editing).id)}` : "tag-closed"}
        tag={editing}
        onClose={() => setEditing(null)}
        onSaved={async (created) => {
          setMessage(created ? "Tag created." : "Tag updated. Existing transaction links now use the new name.");
          setActionError(null);
          await reload();
        }}
      />

      <Modal
        open={Boolean(pendingArchive)}
        onClose={() => setPendingArchive(null)}
        title="Archive tag?"
        description="It will disappear from new transaction entry, while historical links and reports remain intact."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingArchive(null)}>Cancel</Button>
            <Button variant="danger" disabled={saving} onClick={() => pendingArchive && void changeArchiveState(pendingArchive, true)}>
              {saving ? "Archiving…" : "Archive tag"}
            </Button>
          </>
        }
      >
        <div className={ui.inlineNotice}>
          <TagIcon size={17} aria-hidden="true" />
          <span><strong>{stringFrom(readRecord(pendingArchive).name, "This tag")}</strong> remains attached to its existing transactions.</span>
        </div>
      </Modal>
    </Page>
  );
}

function TagForm({ tag, onClose, onSaved }: { tag: Tag | "new" | null; onClose: () => void; onSaved: (created: boolean) => Promise<void> }) {
  const editing = tag && tag !== "new" ? readRecord(tag) : null;
  const [name, setName] = useState("");
  const [color, setColor] = useState("#2563eb");

  useEffect(() => {
    queueMicrotask(() => {
      setName(editing ? stringFrom(editing.name) : "");
      setColor(editing ? stringFrom(editing.color, "#2563eb") : "#2563eb");
    });
  }, [editing]);

  const { submit, submitting, submitError, setSubmitError } = useSubmit(async () => {
    if (!name.trim()) throw new Error("Enter a tag name.");
    await requestJson("/api/tags", {
      method: "POST",
      body: JSON.stringify({ action: editing ? "update" : "create", id: editing?.id, name: name.trim(), color }),
    });
    onClose();
    await onSaved(!editing);
  });

  return (
    <Modal
      open={Boolean(tag)}
      onClose={() => { setSubmitError(null); onClose(); }}
      title={editing ? "Rename tag" : "Add tag"}
      description={editing ? "The updated name will appear on every linked transaction." : "Tags provide a flexible reporting dimension outside the category hierarchy."}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={submitting} onClick={() => void submit()}>{submitting ? "Saving…" : editing ? "Save changes" : "Create tag"}</Button>
        </>
      }
    >
      <form className={ui.formGrid} onSubmit={(event) => void submit(event)}>
        <Field label="Tag name" className={ui.formSpan}>
          <Input autoFocus value={name} maxLength={40} onChange={(event) => setName(event.target.value)} placeholder="e.g. Reimbursable" />
        </Field>
        <Field label="Colour" className={ui.formSpan}>
          <input className={ui.colorInput} type="color" value={color} onChange={(event) => setColor(event.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
      <FormMessage error={submitError} />
    </Modal>
  );
}
