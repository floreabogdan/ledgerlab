import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type DatabaseModule = typeof import("@/db");
type AuthModule = typeof import("@/lib/auth");
type AttachmentModule = typeof import("@/server/attachments");
type PortabilityModule = typeof import("@/server/portability");
type RouteModule = typeof import("@/app/api/[...path]/route");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n", "utf8");
const originalEnvironment = {
  databaseUrl: process.env.DATABASE_URL,
  attachmentsDirectory: process.env.ATTACHMENTS_DIR,
  maxFileBytes: process.env.ATTACHMENT_MAX_FILE_BYTES,
  quotaBytes: process.env.ATTACHMENT_USER_QUOTA_BYTES,
  maxFiles: process.env.ATTACHMENT_MAX_FILES_PER_TRANSACTION,
};

let db: DatabaseModule;
let auth: AuthModule;
let attachments: AttachmentModule;
let portability: PortabilityModule;
let route: RouteModule;
let storageDirectory: string;
let ownerToken: string;
let otherToken: string;

function restoreVariable(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function requestHeaders(token: string, contentType?: string) {
  return {
    cookie: `ledgerlab_session=${token}`,
    origin: "http://localhost:3000",
    ...(contentType ? { "content-type": contentType } : {}),
  };
}

function context(...segments: string[]) {
  return { params: Promise.resolve({ path: segments }) };
}

async function upload(
  transactionId: string,
  fileName: string,
  content: Buffer,
  token = ownerToken,
  contentType = "application/octet-stream",
) {
  return route.POST(
    new NextRequest(
      `http://localhost:3000/api/transactions/${transactionId}/attachments?filename=${encodeURIComponent(fileName)}`,
      { method: "POST", headers: requestHeaders(token, contentType), body: new Blob([Uint8Array.from(content)]) },
    ),
    context("transactions", transactionId, "attachments"),
  );
}

beforeEach(async () => {
  storageDirectory = mkdtempSync(path.join(tmpdir(), "ledgerlab-attachments-"));
  process.env.DATABASE_URL = ":memory:";
  process.env.ATTACHMENTS_DIR = storageDirectory;
  delete process.env.ATTACHMENT_MAX_FILE_BYTES;
  delete process.env.ATTACHMENT_USER_QUOTA_BYTES;
  delete process.env.ATTACHMENT_MAX_FILES_PER_TRANSACTION;
  vi.resetModules();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
  db = await import("@/db");
  auth = await import("@/lib/auth");
  attachments = await import("@/server/attachments");
  portability = await import("@/server/portability");
  route = await import("@/app/api/[...path]/route");
  db.ensureDatabase();
  db.sqlite.prepare(
    `INSERT INTO users (id, email, normalized_email, password_hash, display_name, default_currency)
     VALUES
       ('owner', 'owner@example.test', 'owner@example.test', 'unused', 'Owner', 'RON'),
       ('other', 'other@example.test', 'other@example.test', 'unused', 'Other', 'RON')`,
  ).run();
  db.sqlite.prepare(
    `INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
     VALUES
       ('owner-account', 'owner', 'Owner account', 'current', 'RON', 0, '2026-01-01'),
       ('other-account', 'other', 'Other account', 'current', 'RON', 0, '2026-01-01')`,
  ).run();
  db.sqlite.prepare(
    `INSERT INTO transactions (id, user_id, account_id, kind, status, amount_minor, currency, occurred_at)
     VALUES
       ('owner-transaction', 'owner', 'owner-account', 'expense', 'cleared', -1000, 'RON', '2026-01-02'),
       ('owner-transaction-2', 'owner', 'owner-account', 'expense', 'cleared', -2000, 'RON', '2026-01-03'),
       ('other-transaction', 'other', 'other-account', 'expense', 'cleared', -3000, 'RON', '2026-01-02')`,
  ).run();
  ownerToken = auth.createSession("owner").token;
  otherToken = auth.createSession("other").token;
});

afterEach(() => {
  db.sqlite.close();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
  rmSync(storageDirectory, { recursive: true, force: true });
  restoreVariable("DATABASE_URL", originalEnvironment.databaseUrl);
  restoreVariable("ATTACHMENTS_DIR", originalEnvironment.attachmentsDirectory);
  restoreVariable("ATTACHMENT_MAX_FILE_BYTES", originalEnvironment.maxFileBytes);
  restoreVariable("ATTACHMENT_USER_QUOTA_BYTES", originalEnvironment.quotaBytes);
  restoreVariable("ATTACHMENT_MAX_FILES_PER_TRANSACTION", originalEnvironment.maxFiles);
});

describe("local receipt attachments", () => {
  it("uploads, lists, downloads, and deletes an owned receipt without exposing its storage path", async () => {
    const uploadedResponse = await upload("owner-transaction", "receipt.png", PNG, ownerToken, "image/png");
    expect(uploadedResponse.status).toBe(201);
    const uploaded = await uploadedResponse.json() as { attachment: Record<string, unknown> };
    expect(uploaded.attachment).toMatchObject({
      fileName: "receipt.png",
      kind: "file",
      mimeType: "image/png",
      sizeBytes: PNG.length,
    });
    expect(uploaded.attachment).not.toHaveProperty("storagePath");

    const stored = db.sqlite.prepare(
      "SELECT id, storage_path AS storagePath, sha256 FROM attachments WHERE transaction_id = ?",
    ).get("owner-transaction") as { id: string; storagePath: string; sha256: string };
    const storedPath = attachments.resolveAttachmentStoragePath(stored.storagePath, stored.sha256);
    expect(stored.storagePath).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(storedPath.startsWith(path.resolve(storageDirectory))).toBe(true);
    expect(existsSync(storedPath)).toBe(true);

    const listResponse = await route.GET(
      new NextRequest("http://localhost:3000/api/transactions/owner-transaction/attachments", {
        headers: requestHeaders(ownerToken),
      }),
      context("transactions", "owner-transaction", "attachments"),
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      attachments: [expect.objectContaining({ id: stored.id, kind: "file", sha256: stored.sha256 })],
    });

    const downloadResponse = await route.GET(
      new NextRequest(`http://localhost:3000/api/attachments/${stored.id}/download`, {
        headers: requestHeaders(ownerToken),
      }),
      context("attachments", stored.id, "download"),
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-type")).toBe("image/png");
    expect(downloadResponse.headers.get("content-disposition")).toContain("attachment;");
    expect(downloadResponse.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(downloadResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await downloadResponse.arrayBuffer())).toEqual(PNG);

    const forbiddenDownload = await route.GET(
      new NextRequest(`http://localhost:3000/api/attachments/${stored.id}/download`, {
        headers: requestHeaders(otherToken),
      }),
      context("attachments", stored.id, "download"),
    );
    expect(forbiddenDownload.status).toBe(404);

    const deleteResponse = await route.DELETE(
      new NextRequest(`http://localhost:3000/api/attachments/${stored.id}`, {
        method: "DELETE",
        headers: requestHeaders(ownerToken),
      }),
      context("attachments", stored.id),
    );
    expect(deleteResponse.status).toBe(200);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM attachments WHERE id = ?").get(stored.id)).toEqual({ count: 0 });
    expect(existsSync(storedPath)).toBe(false);
  });

  it("enforces transaction ownership and leaves another user's receipt undiscoverable", async () => {
    const response = await upload("other-transaction", "private.pdf", PDF, ownerToken, "application/pdf");
    expect(response.status).toBe(404);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toEqual({ count: 0 });

    const listResponse = await route.GET(
      new NextRequest("http://localhost:3000/api/transactions/other-transaction/attachments", {
        headers: requestHeaders(ownerToken),
      }),
      context("transactions", "other-transaction", "attachments"),
    );
    expect(listResponse.status).toBe(404);
  });

  it("rejects unsafe names, spoofed types, unsupported content, duplicates, and oversized bodies", async () => {
    expect((await upload("owner-transaction", "../receipt.png", PNG, ownerToken, "image/png")).status).toBe(422);
    expect((await upload("owner-transaction", "receipt.pdf", PNG, ownerToken, "application/pdf")).status).toBe(415);
    expect((await upload(
      "owner-transaction",
      "receipt.svg",
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>", "utf8"),
      ownerToken,
      "image/svg+xml",
    )).status).toBe(415);

    expect((await upload("owner-transaction", "receipt.png", PNG, ownerToken, "image/png")).status).toBe(201);
    expect((await upload("owner-transaction", "receipt-copy.png", PNG, ownerToken, "image/png")).status).toBe(409);

    process.env.ATTACHMENT_MAX_FILE_BYTES = "16";
    process.env.ATTACHMENT_USER_QUOTA_BYTES = "64";
    expect((await upload("owner-transaction-2", "too-large.pdf", PDF, ownerToken, "application/pdf")).status).toBe(413);
  });

  it("uses content-addressed files and removes shared content only after the final reference", async () => {
    expect((await upload("owner-transaction", "first.png", PNG, ownerToken, "image/png")).status).toBe(201);
    expect((await upload("owner-transaction-2", "second.png", PNG, ownerToken, "image/png")).status).toBe(201);
    const rows = db.sqlite.prepare(
      "SELECT id, storage_path AS storagePath, sha256 FROM attachments ORDER BY transaction_id",
    ).all() as Array<{ id: string; storagePath: string; sha256: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.storagePath).toBe(rows[1]!.storagePath);
    const storedPath = attachments.resolveAttachmentStoragePath(rows[0]!.storagePath, rows[0]!.sha256);

    attachments.deleteAttachment("owner", rows[0]!.id);
    expect(existsSync(storedPath)).toBe(true);
    attachments.deleteAttachment("owner", rows[1]!.id);
    expect(existsSync(storedPath)).toBe(false);
  });

  it("enforces per-user quota and per-transaction file-count limits before committing content", async () => {
    process.env.ATTACHMENT_MAX_FILE_BYTES = "80";
    process.env.ATTACHMENT_USER_QUOTA_BYTES = "100";
    process.env.ATTACHMENT_MAX_FILES_PER_TRANSACTION = "10";
    expect((await upload("owner-transaction", "receipt.png", PNG, ownerToken, "image/png")).status).toBe(201);
    expect((await upload("owner-transaction-2", "invoice.pdf", PDF, ownerToken, "application/pdf")).status).toBe(413);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toEqual({ count: 1 });

    process.env.ATTACHMENT_USER_QUOTA_BYTES = "1000";
    process.env.ATTACHMENT_MAX_FILES_PER_TRANSACTION = "1";
    expect((await upload("owner-transaction", "invoice.pdf", PDF, ownerToken, "application/pdf")).status).toBe(409);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toEqual({ count: 1 });
  });

  it("refuses a symlinked storage shard instead of writing outside the configured root", async () => {
    const outsideDirectory = mkdtempSync(path.join(tmpdir(), "ledgerlab-attachment-escape-"));
    const sha256 = createHash("sha256").update(PNG).digest("hex");
    const shard = path.join(storageDirectory, sha256.slice(0, 2));
    try {
      symlinkSync(outsideDirectory, shard, process.platform === "win32" ? "junction" : "dir");
      const response = await upload("owner-transaction", "receipt.png", PNG, ownerToken, "image/png");
      expect(response.status).toBe(500);
      expect(readdirSync(outsideDirectory)).toEqual([]);
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toEqual({ count: 0 });
    } finally {
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });

  it("keeps legacy external references listable and deletable without treating them as files", async () => {
    db.sqlite.prepare(
      `INSERT INTO attachments (id, user_id, transaction_id, file_name, external_reference)
       VALUES ('legacy-reference', 'owner', 'owner-transaction', 'Receipt reference', 'invoice-42')`,
    ).run();
    expect(attachments.listTransactionAttachments("owner", "owner-transaction")).toEqual([
      expect.objectContaining({ id: "legacy-reference", kind: "reference", externalReference: "invoice-42" }),
    ]);
    expect(() => attachments.attachmentDownload("owner", "legacy-reference")).toThrow(/reference/i);
    expect(attachments.deleteAttachment("owner", "legacy-reference")).toEqual({ deleted: true, id: "legacy-reference" });
  });

  it("includes receipt bytes in full backups and restores them with integrity validation", async () => {
    const uploadedResponse = await upload("owner-transaction", "receipt.png", PNG, ownerToken, "image/png");
    const uploaded = await uploadedResponse.json() as { attachment: { id: string } };
    db.sqlite.prepare("DELETE FROM users WHERE id = 'other'").run();
    const backup = portability.createBackup("owner");
    expect(backup.attachments).toEqual([
      expect.objectContaining({ data: PNG.toString("base64"), sizeBytes: PNG.length }),
    ]);

    attachments.deleteAttachment("owner", uploaded.attachment.id);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toEqual({ count: 0 });
    expect(portability.restoreBackup("owner", {
      backup: JSON.stringify(backup),
      confirmation: "RESTORE",
    })).toMatchObject({ success: true });

    const restored = db.sqlite.prepare("SELECT id FROM attachments WHERE id = ?").get(uploaded.attachment.id) as { id: string };
    expect(restored.id).toBe(uploaded.attachment.id);
    expect(attachments.attachmentDownload("owner", restored.id).content).toEqual(PNG);

    const corrupt = structuredClone(backup);
    corrupt.attachments[0]!.data = Buffer.from("not the receipt", "utf8").toString("base64");
    expect(() => portability.restoreBackup("owner", {
      backup: JSON.stringify(corrupt),
      confirmation: "RESTORE",
    })).toThrow(/integrity check/i);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM attachments WHERE id = ?").get(restored.id)).toEqual({ count: 1 });
  });
});
