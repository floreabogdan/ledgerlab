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
import {
  Button,
  FormMessage,
  Modal,
  Page,
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

export default function DataAndBackupsPage() {
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
    try {
      const response = await fetch(`/api/export?format=${format}`);
      if (!response.ok) throw new Error(`Export failed (${response.status}).`);
      downloadBlob(await response.blob(), `ledgerlab-transactions-${new Date().toISOString().slice(0, 10)}.${format}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not export data");
    } finally {
      setWorking(false);
    }
  }

  async function downloadBackup() {
    setWorking(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/backup");
      if (!response.ok) throw new Error(`Backup failed (${response.status}).`);
      downloadBlob(await response.blob(), `ledgerlab-backup-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create backup");
    } finally {
      setWorking(false);
    }
  }

  async function chooseBackup(file?: File) {
    if (!file) return;
    setError(null);
    setSuccess(null);
    if (file.size > 100 * 1024 * 1024) {
      setError("Backup files must be smaller than 100 MB.");
      return;
    }

    const text = await file.text();
    try {
      JSON.parse(text);
    } catch {
      setError("This is not a valid LedgerLab JSON backup.");
      return;
    }

    setRestoreText(text);
    setRestoreName(file.name);
    setRestoreConfirmed(false);
    setRestoreOpen(true);
  }

  async function restoreBackup() {
    setWorking(true);
    setError(null);
    setSuccess(null);
    try {
      if (!restoreConfirmed) throw new Error("Confirm that you understand the current database will be replaced.");
      await requestJson("/api/backup", {
        method: "POST",
        body: JSON.stringify({
          backup: JSON.parse(restoreText),
          fileName: restoreName,
          action: "restore",
          confirmation: "RESTORE",
        }),
      });
      setRestoreOpen(false);
      setRestoreText("");
      if (restoreRef.current) restoreRef.current.value = "";
      setSuccess("Backup restored. Reload other open LedgerLab tabs before making changes.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not restore this backup");
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
        eyebrow="Data management"
        title="Data & backups"
        description="Export portable transaction data, create a complete local backup, or safely restore a previous LedgerLab database."
        actions={<Link href="/import" className={`${kit.button} ${kit.button_secondary}`}><Upload size={15} /> Import transactions</Link>}
      />
      <FormMessage error={error} success={success} />

      <div className={ui.equalColumns}>
        <Section title="Portable exports" description="Download actual transaction data">
          <div className={ui.dataAction}>
            <span className={ui.dataActionIcon}><FileSpreadsheet size={21} /></span>
            <div>
              <strong>CSV export</strong>
              <p>Spreadsheet-friendly actual transactions with readable and integer posted amounts, original currencies, and applied FX snapshots.</p>
            </div>
            <div className={ui.dataActionButtons}>
              <Button disabled={working} variant="secondary" icon={<Download size={15} />} onClick={() => void exportData("csv")}>Download CSV</Button>
            </div>
          </div>
          <div className={ui.dataAction}>
            <span className={ui.dataActionIcon}><FileJson size={21} /></span>
            <div>
              <strong>JSON export</strong>
              <p>Structured accounts, categories and actual transactions, including exact dated exchange-rate provenance.</p>
            </div>
            <div className={ui.dataActionButtons}>
              <Button disabled={working} variant="secondary" icon={<Download size={15} />} onClick={() => void exportData("json")}>Download JSON</Button>
            </div>
          </div>
        </Section>

        <Section title="Full database safety" description="Backup or restore all local LedgerLab data">
          <div className={ui.dataAction}>
            <span className={ui.dataActionIcon}><HardDriveDownload size={21} /></span>
            <div>
              <strong>Create full backup</strong>
              <p>Includes accounts, balances, transactions, plans, budgets, recurrence rules, profile settings, and the downloaded BNR rate cache.</p>
            </div>
            <div className={ui.dataActionButtons}>
              <Button disabled={working} variant="secondary" icon={<Download size={15} />} onClick={() => void downloadBackup()}>Download backup</Button>
            </div>
          </div>
          <div className={ui.dataAction}>
            <span className={ui.dataActionIcon}><Database size={21} /></span>
            <div>
              <strong>Restore a backup</strong>
              <p>Validates a LedgerLab backup before replacing data for the signed-in local user.</p>
            </div>
            <div className={ui.dataActionButtons}>
              <Button disabled={working} variant="secondary" icon={<Upload size={15} />} onClick={() => restoreRef.current?.click()}>Choose backup</Button>
              <input ref={restoreRef} className={ui.hiddenFile} type="file" accept=".json,application/json" onChange={(event) => void chooseBackup(event.target.files?.[0])} />
            </div>
          </div>
        </Section>
      </div>

      <Modal
        open={restoreOpen}
        onClose={closeRestore}
        title="Restore full database backup?"
        description={restoreName}
        footer={(
          <>
            <Button variant="ghost" disabled={working} onClick={closeRestore}>Cancel</Button>
            <Button variant="danger" disabled={working || !restoreConfirmed} onClick={() => void restoreBackup()}>{working ? "Restoring…" : "Replace data & restore"}</Button>
          </>
        )}
      >
        <div className={`${ui.inlineNotice} ${ui.inlineNoticeDanger}`}>
          <Database size={17} />
          <span><strong>This replaces current LedgerLab data.</strong><br />Create a fresh backup first if you may need to recover the current state. Sessions for other browser tabs may become stale.</span>
        </div>
        <label className={`${ui.inlineNotice} ${ui.noticeOffset}`}>
          <input type="checkbox" checked={restoreConfirmed} onChange={(event) => setRestoreConfirmed(event.target.checked)} />
          <span>I understand that current finance data will be replaced by the selected backup.</span>
        </label>
      </Modal>
    </Page>
  );
}
