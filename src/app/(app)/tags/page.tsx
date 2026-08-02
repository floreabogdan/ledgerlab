"use client";

import { Archive, Pencil, RotateCcw, Tag as TagIcon } from "lucide-react";
import { useEffect, useState } from "react";
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
  const t = useTranslations();
  const translator = useTranslator();
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
      }, translator);
      setPendingArchive(null);
      setMessage(archive ? t("entities.tags.feedback.archived") : t("entities.tags.feedback.restored"));
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : t("entities.tags.feedback.updateFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow={t("entities.shared.eyebrow")}
        title={t("entities.tags.header.title")}
        description={t("entities.tags.header.description")}
        actions={<AddButton onClick={() => setEditing("new")}>{t("entities.tags.actions.add")}</AddButton>}
      />

      <div className={ui.metricGrid}>
        <Metric label={t("entities.tags.metrics.active.label")} value={active.length} tone="accent" detail={t("entities.tags.metrics.active.detail")} />
        <Metric label={t("entities.tags.metrics.links.label")} value={totalUses} detail={t("entities.tags.metrics.links.detail")} />
        <Metric label={t("entities.tags.metrics.unused.label")} value={unused} detail={t("entities.tags.metrics.unused.detail")} />
        <Metric label={t("entities.tags.metrics.archived.label")} value={archived.length} detail={t("entities.tags.metrics.archived.detail")} />
      </div>

      <FormMessage error={actionError} success={message} />
      <Section
        title={t("entities.tags.section.title")}
        description={t("entities.tags.section.description")}
        action={
          <Toggle
            checked={showArchived}
            onChange={setShowArchived}
            label={t("entities.tags.toggle.label")}
            description={t("entities.tags.toggle.description")}
          />
        }
      >
        <DataState
          loading={loading}
          error={error}
          onRetry={reload}
          empty={!visible.length}
          emptyTitle={showArchived ? t("entities.tags.empty.allTitle") : t("entities.tags.empty.activeTitle")}
          emptyDescription={t("entities.tags.empty.description")}
          action={<AddButton onClick={() => setEditing("new")}>{t("entities.tags.actions.add")}</AddButton>}
        >
          <ResponsiveTable label={t("entities.tags.table.label")}>
            <thead>
              <tr>
                <th>{t("entities.tags.table.tag")}</th>
                <th>{t("entities.tags.table.transactions")}</th>
                <th>{t("entities.tags.table.status")}</th>
                <th><span className="sr-only">{t("entities.shared.table.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item, index) => {
                const tag = readRecord(item);
                const archivedTag = isArchived(item);
                const name = stringFrom(tag.name, t("entities.shared.fallback.unnamedTag"));
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
                    <td><Pill tone={archivedTag ? "neutral" : "info"}>{archivedTag ? t("entities.shared.status.archived") : t("entities.shared.status.active")}</Pill></td>
                    <td>
                      <div className={ui.paymentActions}>
                        <IconButton label={t("entities.tags.actions.renameNamed", { name })} onClick={() => setEditing(item)}><Pencil size={15} /></IconButton>
                        {archivedTag ? (
                          <IconButton label={t("entities.tags.actions.restoreNamed", { name })} onClick={() => void changeArchiveState(item, false)}><RotateCcw size={15} /></IconButton>
                        ) : (
                          <IconButton label={t("entities.tags.actions.archiveNamed", { name })} onClick={() => setPendingArchive(item)}><Archive size={15} /></IconButton>
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
          setMessage(created ? t("entities.tags.feedback.created") : t("entities.tags.feedback.updated"));
          setActionError(null);
          await reload();
        }}
      />

      <Modal
        open={Boolean(pendingArchive)}
        onClose={() => setPendingArchive(null)}
        title={t("entities.tags.archive.title")}
        description={t("entities.tags.archive.description")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingArchive(null)}>{t("common.actions.cancel")}</Button>
            <Button variant="danger" disabled={saving} onClick={() => pendingArchive && void changeArchiveState(pendingArchive, true)}>
              {saving ? t("entities.tags.actions.archiving") : t("entities.tags.archive.confirm")}
            </Button>
          </>
        }
      >
        <div className={ui.inlineNotice}>
          <TagIcon size={17} aria-hidden="true" />
          <span>{t("entities.tags.archive.notice", { name: stringFrom(readRecord(pendingArchive).name, t("entities.shared.fallback.thisTag")) })}</span>
        </div>
      </Modal>
    </Page>
  );
}

function TagForm({ tag, onClose, onSaved }: { tag: Tag | "new" | null; onClose: () => void; onSaved: (created: boolean) => Promise<void> }) {
  const t = useTranslations();
  const translator = useTranslator();
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
    if (!name.trim()) throw new Error(t("entities.tags.form.nameRequired"));
    await requestJson("/api/tags", {
      method: "POST",
      body: JSON.stringify({ action: editing ? "update" : "create", id: editing?.id, name: name.trim(), color }),
    }, translator);
    onClose();
    await onSaved(!editing);
  });

  return (
    <Modal
      open={Boolean(tag)}
      onClose={() => { setSubmitError(null); onClose(); }}
      title={editing ? t("entities.tags.form.renameTitle") : t("entities.tags.form.addTitle")}
      description={editing ? t("entities.tags.form.renameDescription") : t("entities.tags.form.addDescription")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("common.actions.cancel")}</Button>
          <Button disabled={submitting} onClick={() => void submit()}>{submitting ? t("entities.tags.actions.saving") : editing ? t("entities.tags.actions.saveChanges") : t("entities.tags.actions.create")}</Button>
        </>
      }
    >
      <form className={ui.formGrid} onSubmit={(event) => void submit(event)}>
        <Field label={t("entities.tags.form.name")} className={ui.formSpan}>
          <Input autoFocus value={name} maxLength={40} onChange={(event) => setName(event.target.value)} placeholder={t("entities.tags.form.namePlaceholder")} />
        </Field>
        <Field label={t("entities.tags.form.colour")} className={ui.formSpan}>
          <input className={ui.colorInput} type="color" value={color} onChange={(event) => setColor(event.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
      <FormMessage error={submitError} />
    </Modal>
  );
}
