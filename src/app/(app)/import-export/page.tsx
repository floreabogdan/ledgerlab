"use client";

import Link from "next/link";
import {
  Database,
  Download,
  FileJson,
  FileSpreadsheet,
  HardDriveDownload,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { useTranslator } from "@/i18n/client";
import type { Translator } from "@/i18n/runtime";
import { parseApiError, translateApiError } from "@/lib/api-error";
import {
  Button,
  FormMessage,
  Modal,
  Page,
  RequestError,
  requestJson,
  Section,
  ViewHeader,
} from "../_components/feature-kit";
import kit from "../_components/feature.module.css";
import ui from "../_components/pages.module.css";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function translatedResponseError(
  response: Response,
  translator: Translator,
) {
  const body: unknown = await response.json().catch(() => null);
  return translateApiError(translator, parseApiError(body));
}

export default function DataAndBackupsPage() {
  const translator = useTranslator();
  const t = translator.translate;
  const restoreRef = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [restoreText, setRestoreText] = useState("");
  const [restoreName, setRestoreName] = useState("");
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);

  async function exportData(format: "csv" | "json") {
    setWorking(true);
    setError(null);
    setSuccess(null);
    let failure = t("settings.data.errors.exportFailed");
    try {
      const response = await fetch(`/api/export?format=${format}`);
      if (!response.ok) {
        failure = await translatedResponseError(response, translator);
        throw new Error("export_request_rejected");
      }
      downloadBlob(
        await response.blob(),
        `ledgerlab-transactions-${new Date().toISOString().slice(0, 10)}.${format}`,
      );
    } catch {
      setError(failure);
    } finally {
      setWorking(false);
    }
  }

  async function downloadBackup() {
    setWorking(true);
    setError(null);
    setSuccess(null);
    let failure = t("settings.data.errors.backupFailed");
    try {
      const response = await fetch("/api/backup");
      if (!response.ok) {
        failure = await translatedResponseError(response, translator);
        throw new Error("backup_request_rejected");
      }
      downloadBlob(
        await response.blob(),
        `ledgerlab-backup-${new Date().toISOString().slice(0, 10)}.json`,
      );
    } catch {
      setError(failure);
    } finally {
      setWorking(false);
    }
  }

  async function chooseBackup(file?: File) {
    if (!file) return;
    setError(null);
    setSuccess(null);
    if (file.size > 100 * 1024 * 1024) {
      setError(t("settings.data.errors.fileTooLarge"));
      return;
    }

    let text: string;
    try {
      text = await file.text();
      JSON.parse(text);
    } catch {
      setError(t("settings.data.errors.invalidFile"));
      return;
    }

    setRestoreText(text);
    setRestoreName(file.name);
    setRestoreConfirmed(false);
    setRestoreOpen(true);
  }

  async function restoreBackup() {
    setError(null);
    setSuccess(null);
    if (!restoreConfirmed) {
      setError(t("settings.data.errors.confirmationRequired"));
      return;
    }

    setWorking(true);
    try {
      await requestJson(
        "/api/backup",
        {
          method: "POST",
          body: JSON.stringify({
            backup: JSON.parse(restoreText),
            fileName: restoreName,
            action: "restore",
            confirmation: "RESTORE",
          }),
        },
        translator,
      );
      setRestoreOpen(false);
      setRestoreText("");
      if (restoreRef.current) restoreRef.current.value = "";
      setSuccess(t("settings.data.restored"));
    } catch (caught) {
      setError(
        caught instanceof RequestError
          ? caught.message
          : t("settings.data.errors.restoreFailed"),
      );
    } finally {
      setWorking(false);
    }
  }

  function closeRestore() {
    if (working) return;
    setRestoreOpen(false);
    setRestoreText("");
    setRestoreName("");
    setRestoreConfirmed(false);
    if (restoreRef.current) restoreRef.current.value = "";
  }

  return (
    <Page>
      <ViewHeader
        eyebrow={t("settings.data.eyebrow")}
        title={t("settings.data.title")}
        description={t("settings.data.description")}
        actions={
          <Link
            href="/import"
            className={`${kit.button} ${kit.button_secondary}`}
          >
            <Upload size={15} aria-hidden="true" />
            {t("settings.data.importTransactions")}
          </Link>
        }
      />
      <FormMessage error={error} success={success} />

      <div className={ui.equalColumns}>
        <Section
          title={t("settings.data.portable.title")}
          description={t("settings.data.portable.description")}
        >
          <div className={ui.dataAction}>
            <span className={ui.dataActionIcon}>
              <FileSpreadsheet size={21} aria-hidden="true" />
            </span>
            <div>
              <strong>{t("settings.data.portable.csvTitle")}</strong>
              <p>{t("settings.data.portable.csvDescription")}</p>
            </div>
            <div className={ui.dataActionButtons}>
              <Button
                disabled={working}
                variant="secondary"
                icon={<Download size={15} />}
                onClick={() => void exportData("csv")}
              >
                {t("settings.data.portable.csvButton")}
              </Button>
            </div>
          </div>
          <div className={ui.dataAction}>
            <span className={ui.dataActionIcon}>
              <FileJson size={21} aria-hidden="true" />
            </span>
            <div>
              <strong>{t("settings.data.portable.jsonTitle")}</strong>
              <p>{t("settings.data.portable.jsonDescription")}</p>
            </div>
            <div className={ui.dataActionButtons}>
              <Button
                disabled={working}
                variant="secondary"
                icon={<Download size={15} />}
                onClick={() => void exportData("json")}
              >
                {t("settings.data.portable.jsonButton")}
              </Button>
            </div>
          </div>
        </Section>

        <Section
          title={t("settings.data.safety.title")}
          description={t("settings.data.safety.description")}
        >
          <div className={ui.dataAction}>
            <span className={ui.dataActionIcon}>
              <HardDriveDownload size={21} aria-hidden="true" />
            </span>
            <div>
              <strong>{t("settings.data.safety.createTitle")}</strong>
              <p>{t("settings.data.safety.createDescription")}</p>
            </div>
            <div className={ui.dataActionButtons}>
              <Button
                disabled={working}
                variant="secondary"
                icon={<Download size={15} />}
                onClick={() => void downloadBackup()}
              >
                {t("settings.data.safety.createButton")}
              </Button>
            </div>
          </div>
          <div className={ui.dataAction}>
            <span className={ui.dataActionIcon}>
              <Database size={21} aria-hidden="true" />
            </span>
            <div>
              <strong>{t("settings.data.safety.restoreTitle")}</strong>
              <p>{t("settings.data.safety.restoreDescription")}</p>
            </div>
            <div className={ui.dataActionButtons}>
              <Button
                disabled={working}
                variant="secondary"
                icon={<Upload size={15} />}
                onClick={() => restoreRef.current?.click()}
              >
                {t("settings.data.safety.restoreButton")}
              </Button>
              <input
                ref={restoreRef}
                className={ui.hiddenFile}
                type="file"
                accept=".json,application/json"
                onChange={(event) =>
                  void chooseBackup(event.target.files?.[0])
                }
              />
            </div>
          </div>
        </Section>
      </div>

      <Modal
        open={restoreOpen}
        onClose={closeRestore}
        title={t("settings.data.confirmation.title")}
        description={restoreName}
        footer={
          <>
            <Button variant="ghost" disabled={working} onClick={closeRestore}>
              {t("settings.data.confirmation.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={working || !restoreConfirmed}
              onClick={() => void restoreBackup()}
            >
              {working
                ? t("settings.data.confirmation.restoring")
                : t("settings.data.confirmation.replace")}
            </Button>
          </>
        }
      >
        <div className={`${ui.inlineNotice} ${ui.inlineNoticeDanger}`}>
          <Database size={17} aria-hidden="true" />
          <span>
            <strong>{t("settings.data.confirmation.warning")}</strong>
            <br />
            {t("settings.data.confirmation.warningHelp")}
          </span>
        </div>
        <label className={`${ui.inlineNotice} ${ui.noticeOffset}`}>
          <input
            type="checkbox"
            checked={restoreConfirmed}
            onChange={(event) => setRestoreConfirmed(event.target.checked)}
          />
          <span>{t("settings.data.confirmation.acknowledgement")}</span>
        </label>
      </Modal>
    </Page>
  );
}
