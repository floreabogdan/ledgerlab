import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { HttpError } from "@/lib/api-response";
import { audit, database, one } from "@/server/core";

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_USER_QUOTA_BYTES = 250 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_TRANSACTION = 10;
const MAX_CONFIGURED_FILE_BYTES = 100 * 1024 * 1024;
const MAX_CONFIGURED_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
const STORAGE_PATH_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type AttachmentRow = {
  id: string;
  transactionId: string | null;
  plannedPaymentId: string | null;
  fileName: string;
  storagePath: string | null;
  externalReference: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  createdAt: string;
};

export type AttachmentMetadata = Omit<AttachmentRow, "storagePath"> & {
  kind: "file" | "reference";
};

export type AttachmentBackupFile = {
  storagePath: string;
  sizeBytes: number;
  sha256: string;
  data: string;
};

function configuredInteger(name: string, fallback: number, maximum: number) {
  const configured = process.env[name]?.trim();
  if (!configured) return fallback;
  if (!/^\d+$/.test(configured)) throw new HttpError(500, `${name} must be a positive integer`);
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new HttpError(500, `${name} must be between 1 and ${maximum}`);
  }
  return value;
}

export function attachmentLimits() {
  const maxFileBytes = configuredInteger(
    "ATTACHMENT_MAX_FILE_BYTES",
    DEFAULT_MAX_FILE_BYTES,
    MAX_CONFIGURED_FILE_BYTES,
  );
  const userQuotaBytes = configuredInteger(
    "ATTACHMENT_USER_QUOTA_BYTES",
    DEFAULT_USER_QUOTA_BYTES,
    MAX_CONFIGURED_QUOTA_BYTES,
  );
  if (userQuotaBytes < maxFileBytes) {
    throw new HttpError(500, "ATTACHMENT_USER_QUOTA_BYTES cannot be smaller than ATTACHMENT_MAX_FILE_BYTES");
  }
  return {
    maxFileBytes,
    userQuotaBytes,
    maxFilesPerTransaction: configuredInteger(
      "ATTACHMENT_MAX_FILES_PER_TRANSACTION",
      DEFAULT_MAX_FILES_PER_TRANSACTION,
      100,
    ),
  };
}

function databaseFilePath() {
  const configured = process.env.DATABASE_URL?.trim() || "./data/ledgerlab.db";
  const file = configured.startsWith("file:") ? configured.slice("file:".length) : configured;
  return file === ":memory:" ? path.resolve("data", "ledgerlab.db") : path.resolve(file);
}

export function attachmentStorageRoot() {
  const configured = process.env.ATTACHMENTS_DIR?.trim();
  const resolved = configured ? path.resolve(configured) : path.join(path.dirname(databaseFilePath()), "attachments");
  if (resolved === path.parse(resolved).root) {
    throw new HttpError(500, "ATTACHMENTS_DIR cannot be a filesystem root");
  }
  return resolved;
}

function ensureStorageRoot() {
  const root = attachmentStorageRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function ensureStorageChildDirectory(name: string) {
  if (!/^(?:[0-9a-f]{2}|\.tmp)$/.test(name)) throw new HttpError(500, "Attachment storage directory is invalid");
  const root = ensureStorageRoot();
  const rootRealPath = realpathSync(root);
  const child = path.join(root, name);
  if (existsSync(child)) {
    const childStats = lstatSync(child);
    if (childStats.isSymbolicLink() || !childStats.isDirectory()) {
      throw new HttpError(500, "Attachment storage contains an unsafe directory entry");
    }
  } else {
    mkdirSync(child, { mode: 0o700 });
  }
  const childRealPath = realpathSync(child);
  const relative = path.relative(rootRealPath, childRealPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpError(500, "Attachment storage directory escaped its configured root");
  }
  return childRealPath;
}

export function attachmentStoragePathForHash(sha256: string) {
  const normalized = sha256.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new HttpError(500, "Attachment storage metadata is invalid");
  return `${normalized.slice(0, 2)}/${normalized}`;
}

function assertStoragePath(storagePath: string, sha256?: string | null) {
  const normalized = storagePath.replaceAll("\\", "/").toLowerCase();
  if (!STORAGE_PATH_PATTERN.test(normalized)) throw new HttpError(500, "Attachment storage metadata is invalid");
  if (sha256 && attachmentStoragePathForHash(sha256) !== normalized) {
    throw new HttpError(500, "Attachment storage checksum does not match its path");
  }
  return normalized;
}

export function resolveAttachmentStoragePath(storagePath: string, sha256?: string | null) {
  const normalized = assertStoragePath(storagePath, sha256);
  const [shard, fileName] = normalized.split("/") as [string, string];
  return path.join(ensureStorageChildDirectory(shard), fileName);
}

function assertOwnedTransaction(userId: string, transactionId: string) {
  const transaction = one<{ id: string }>(
    "SELECT id FROM transactions WHERE id = ? AND user_id = ?",
    [transactionId, userId],
  );
  if (!transaction) throw new HttpError(404, "Transaction not found");
}

function toMetadata(row: AttachmentRow): AttachmentMetadata {
  const { storagePath, ...metadata } = row;
  return { ...metadata, kind: storagePath ? "file" : "reference" };
}

export function listTransactionAttachments(userId: string, transactionId: string) {
  assertOwnedTransaction(userId, transactionId);
  const rows = database().prepare(
    `SELECT id, transaction_id AS transactionId, planned_payment_id AS plannedPaymentId,
            file_name AS fileName, storage_path AS storagePath,
            external_reference AS externalReference, mime_type AS mimeType,
            size_bytes AS sizeBytes, sha256, created_at AS createdAt
       FROM attachments
      WHERE user_id = ? AND transaction_id = ?
      ORDER BY created_at, id`,
  ).all(userId, transactionId) as AttachmentRow[];
  return rows.map(toMetadata);
}

function normalizedFilename(input: string) {
  const value = input.normalize("NFC").trim();
  if (!value || value.length > 180 || Buffer.byteLength(value, "utf8") > 255) {
    throw new HttpError(422, "Attachment filenames must be between 1 and 180 characters");
  }
  if (/[\u0000-\u001f\u007f/\\]/.test(value) || /^[.\-\s]/.test(value) || /[.\s]$/.test(value)) {
    throw new HttpError(422, "Attachment filename contains unsafe characters");
  }
  return value;
}

type DetectedFileType = { mimeType: string; extensions: readonly string[] };

function detectFileType(header: Buffer): DetectedFileType | null {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: "image/png", extensions: [".png"] };
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { mimeType: "image/jpeg", extensions: [".jpg", ".jpeg"] };
  }
  if (
    header.length >= 12
    && header.subarray(0, 4).toString("ascii") === "RIFF"
    && header.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mimeType: "image/webp", extensions: [".webp"] };
  }
  if (header.length >= 5 && header.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { mimeType: "application/pdf", extensions: [".pdf"] };
  }
  if (header.length >= 12 && header.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = header.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return { mimeType: "image/heic", extensions: [".heic", ".heif"] };
    }
  }
  return null;
}

function normalizedClaimedMimeType(value: string | null) {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
  return mime === "image/jpg" ? "image/jpeg" : mime === "image/heif" ? "image/heic" : mime;
}

function assertContentLength(value: string | null, maxBytes: number) {
  if (!value) return;
  if (!/^\d+$/.test(value)) throw new HttpError(400, "Content-Length must be a non-negative integer");
  if (BigInt(value) > BigInt(maxBytes)) throw new HttpError(413, `Receipt files must not exceed ${maxBytes} bytes`);
}

async function writeUploadToTemporaryFile(body: ReadableStream<Uint8Array> | null, maxBytes: number) {
  if (!body) throw new HttpError(400, "Choose a receipt file to upload");
  const temporaryDirectory = ensureStorageChildDirectory(".tmp");
  const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.upload`);
  const handle = await open(temporaryPath, "wx", 0o600);
  const reader = body.getReader();
  const digest = createHash("sha256");
  let header = Buffer.alloc(0);
  let sizeBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sizeBytes += value.byteLength;
      if (sizeBytes > maxBytes) {
        try { await reader.cancel(); } catch { /* Preserve the useful size error. */ }
        throw new HttpError(413, `Receipt files must not exceed ${maxBytes} bytes`);
      }
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      digest.update(chunk);
      if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
        if (bytesWritten < 1) throw new Error("Could not write the receipt file");
        offset += bytesWritten;
      }
    }
    if (sizeBytes < 1) throw new HttpError(422, "Receipt files cannot be empty");
    await handle.sync();
    return { temporaryPath, sizeBytes, sha256: digest.digest("hex"), header };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function installTemporaryFile(temporaryPath: string, storagePath: string, sha256: string, sizeBytes: number) {
  const finalPath = resolveAttachmentStoragePath(storagePath, sha256);
  try {
    copyFileSync(temporaryPath, finalPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    const existing = await readFile(finalPath);
    if (existing.length !== sizeBytes || createHash("sha256").update(existing).digest("hex") !== sha256) {
      throw new HttpError(500, "Stored attachment content failed its integrity check");
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return finalPath;
}

function assertAttachmentCapacity(
  userId: string,
  transactionId: string,
  sizeBytes: number,
  sha256: string,
  limits: ReturnType<typeof attachmentLimits>,
) {
  const totalBytes = one<{ totalBytes: number }>(
    `SELECT COALESCE(SUM(size_bytes), 0) AS totalBytes
       FROM attachments
      WHERE user_id = ? AND storage_path IS NOT NULL`,
    [userId],
  )?.totalBytes ?? 0;
  const transactionFileCount = one<{ count: number }>(
    "SELECT COUNT(*) AS count FROM attachments WHERE transaction_id = ? AND storage_path IS NOT NULL",
    [transactionId],
  )?.count ?? 0;
  if (transactionFileCount >= limits.maxFilesPerTransaction) {
    throw new HttpError(409, `A transaction can have at most ${limits.maxFilesPerTransaction} receipt files`);
  }
  if (totalBytes + sizeBytes > limits.userQuotaBytes) {
    throw new HttpError(413, "The attachment storage quota has been reached");
  }
  const duplicate = one<{ id: string }>(
    "SELECT id FROM attachments WHERE transaction_id = ? AND sha256 = ? LIMIT 1",
    [transactionId, sha256],
  );
  if (duplicate) throw new HttpError(409, "This receipt file is already attached to the transaction");
}

export async function uploadTransactionAttachment(
  userId: string,
  transactionId: string,
  input: {
    fileName: string;
    claimedMimeType: string | null;
    contentLength: string | null;
    body: ReadableStream<Uint8Array> | null;
  },
) {
  assertOwnedTransaction(userId, transactionId);
  const fileName = normalizedFilename(input.fileName);
  const limits = attachmentLimits();
  assertContentLength(input.contentLength, limits.maxFileBytes);
  const uploaded = await writeUploadToTemporaryFile(input.body, limits.maxFileBytes);
  const detected = detectFileType(uploaded.header);
  try {
    if (!detected) {
      throw new HttpError(415, "Only PDF, PNG, JPEG, WebP, HEIC, and HEIF receipt files are supported");
    }
    const extension = path.extname(fileName).toLowerCase();
    if (!detected.extensions.includes(extension)) {
      throw new HttpError(415, `The filename extension does not match the detected ${detected.mimeType} content`);
    }
    const claimed = normalizedClaimedMimeType(input.claimedMimeType);
    if (claimed !== "application/octet-stream" && claimed !== detected.mimeType) {
      throw new HttpError(415, "The declared file type does not match the receipt content");
    }
    const storagePath = attachmentStoragePathForHash(uploaded.sha256);
    assertAttachmentCapacity(userId, transactionId, uploaded.sizeBytes, uploaded.sha256, limits);
    await installTemporaryFile(uploaded.temporaryPath, storagePath, uploaded.sha256, uploaded.sizeBytes);
    const attachment = database().transaction(() => {
      assertOwnedTransaction(userId, transactionId);
      assertAttachmentCapacity(userId, transactionId, uploaded.sizeBytes, uploaded.sha256, limits);
      const id = randomUUID();
      database().prepare(
        `INSERT INTO attachments
          (id, user_id, transaction_id, file_name, storage_path, mime_type, size_bytes, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        userId,
        transactionId,
        fileName,
        storagePath,
        detected.mimeType,
        uploaded.sizeBytes,
        uploaded.sha256,
      );
      audit(userId, "attachment", id, "upload", undefined, {
        transactionId,
        fileName,
        mimeType: detected.mimeType,
        sizeBytes: uploaded.sizeBytes,
        sha256: uploaded.sha256,
      });
      return one<AttachmentRow>(
        `SELECT id, transaction_id AS transactionId, planned_payment_id AS plannedPaymentId,
                file_name AS fileName, storage_path AS storagePath,
                external_reference AS externalReference, mime_type AS mimeType,
                size_bytes AS sizeBytes, sha256, created_at AS createdAt
           FROM attachments WHERE id = ?`,
        [id],
      )!;
    })();
    return toMetadata(attachment);
  } catch (error) {
    await rm(uploaded.temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function ownedAttachment(userId: string, attachmentId: string) {
  const row = one<AttachmentRow>(
    `SELECT id, transaction_id AS transactionId, planned_payment_id AS plannedPaymentId,
            file_name AS fileName, storage_path AS storagePath,
            external_reference AS externalReference, mime_type AS mimeType,
            size_bytes AS sizeBytes, sha256, created_at AS createdAt
       FROM attachments WHERE id = ? AND user_id = ?`,
    [attachmentId, userId],
  );
  if (!row) throw new HttpError(404, "Attachment not found");
  return row;
}

export function attachmentDownload(userId: string, attachmentId: string) {
  const row = ownedAttachment(userId, attachmentId);
  if (!row.storagePath || !row.sha256 || row.sizeBytes === null || !row.mimeType) {
    throw new HttpError(404, "This attachment is a reference and has no local file");
  }
  const filePath = resolveAttachmentStoragePath(row.storagePath, row.sha256);
  let rootRealPath: string;
  let fileRealPath: string;
  try {
    rootRealPath = realpathSync(ensureStorageRoot());
    const direct = lstatSync(filePath);
    if (direct.isSymbolicLink() || !direct.isFile()) throw new Error("Not a regular file");
    fileRealPath = realpathSync(filePath);
    const relative = path.relative(rootRealPath, fileRealPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Outside storage root");
    const actual = statSync(fileRealPath);
    if (actual.size !== row.sizeBytes) throw new Error("Size mismatch");
  } catch {
    throw new HttpError(410, "The stored receipt file is missing or failed its integrity check");
  }
  const content = readFileSync(fileRealPath);
  if (createHash("sha256").update(content).digest("hex") !== row.sha256) {
    throw new HttpError(410, "The stored receipt file is missing or failed its integrity check");
  }
  return { ...toMetadata(row), content };
}

export function attachmentContentDisposition(fileName: string) {
  const fallback = fileName
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 120) || "receipt";
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function deleteAttachment(userId: string, attachmentId: string) {
  const row = ownedAttachment(userId, attachmentId);
  const shouldDeleteFile = database().transaction(() => {
    const result = database().prepare("DELETE FROM attachments WHERE id = ? AND user_id = ?").run(attachmentId, userId);
    if (result.changes !== 1) throw new HttpError(404, "Attachment not found");
    audit(userId, "attachment", attachmentId, "delete", {
      transactionId: row.transactionId,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
    });
    if (!row.storagePath) return false;
    return (one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM attachments WHERE storage_path = ?",
      [row.storagePath],
    )?.count ?? 0) === 0;
  })();
  if (shouldDeleteFile && row.storagePath) {
    try {
      rmSync(resolveAttachmentStoragePath(row.storagePath, row.sha256), { force: true });
    } catch (error) {
      console.error("Could not remove orphaned receipt content", error);
    }
  }
  return { deleted: true, id: attachmentId };
}

export function collectAttachmentBackupFiles(userId: string): AttachmentBackupFile[] {
  const rows = database().prepare(
    `SELECT DISTINCT storage_path AS storagePath, size_bytes AS sizeBytes, sha256
       FROM attachments
      WHERE user_id = ? AND storage_path IS NOT NULL
      ORDER BY storage_path`,
  ).all(userId) as Array<{ storagePath: string; sizeBytes: number; sha256: string }>;
  const files = new Map<string, AttachmentBackupFile>();
  for (const row of rows) {
    const storagePath = assertStoragePath(row.storagePath, row.sha256);
    const existingMetadata = files.get(storagePath);
    if (existingMetadata) {
      if (existingMetadata.sizeBytes !== row.sizeBytes || existingMetadata.sha256 !== row.sha256) {
        throw new HttpError(409, `Receipt metadata conflicts for ${storagePath}`);
      }
      continue;
    }
    const filePath = resolveAttachmentStoragePath(storagePath, row.sha256);
    let content: Buffer;
    try {
      const direct = lstatSync(filePath);
      if (direct.isSymbolicLink() || !direct.isFile()) throw new Error("Not a regular file");
      content = readFileSync(filePath);
    } catch {
      throw new HttpError(409, `Receipt content is missing for ${storagePath}; repair or delete that attachment before backing up`);
    }
    if (content.length !== row.sizeBytes || createHash("sha256").update(content).digest("hex") !== row.sha256) {
      throw new HttpError(409, `Receipt content failed its integrity check for ${storagePath}`);
    }
    files.set(storagePath, {
      storagePath,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      data: content.toString("base64"),
    });
  }
  return [...files.values()];
}

function decodeBackupFile(file: AttachmentBackupFile) {
  const storagePath = assertStoragePath(file.storagePath, file.sha256);
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1) {
    throw new HttpError(422, "The backup contains an invalid receipt size");
  }
  if (typeof file.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) {
    throw new HttpError(422, "The backup contains invalid receipt data");
  }
  const content = Buffer.from(file.data, "base64");
  if (content.length !== file.sizeBytes || createHash("sha256").update(content).digest("hex") !== file.sha256) {
    throw new HttpError(422, "A receipt in the backup failed its integrity check");
  }
  return { storagePath, content };
}

export function validateAttachmentBackupFiles(
  files: AttachmentBackupFile[],
  expected: Array<{ storagePath: string; sizeBytes: number; sha256: string }>,
) {
  if (!Array.isArray(files)) throw new HttpError(422, "The backup receipt manifest is invalid");
  const expectedByPath = new Map<string, { sizeBytes: number; sha256: string }>();
  for (const row of expected) {
    const storagePath = assertStoragePath(row.storagePath, row.sha256);
    const existing = expectedByPath.get(storagePath);
    if (existing && (existing.sizeBytes !== row.sizeBytes || existing.sha256 !== row.sha256)) {
      throw new HttpError(422, "The backup contains conflicting receipt metadata");
    }
    expectedByPath.set(storagePath, { sizeBytes: row.sizeBytes, sha256: row.sha256 });
  }
  const decoded = new Map<string, Buffer>();
  for (const file of files) {
    if (!file || typeof file !== "object") throw new HttpError(422, "The backup receipt manifest is invalid");
    const result = decodeBackupFile(file);
    if (decoded.has(result.storagePath)) throw new HttpError(422, "The backup contains a duplicate receipt entry");
    const expectedFile = expectedByPath.get(result.storagePath);
    if (!expectedFile || expectedFile.sizeBytes !== file.sizeBytes || expectedFile.sha256 !== file.sha256) {
      throw new HttpError(422, "The backup receipt manifest does not match its database metadata");
    }
    decoded.set(result.storagePath, result.content);
  }
  if (decoded.size !== expectedByPath.size) throw new HttpError(422, "The backup is missing receipt file content");
  return decoded;
}

export function installAttachmentBackupFiles(files: Map<string, Buffer>) {
  for (const [storagePath, content] of files) {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const target = resolveAttachmentStoragePath(storagePath, sha256);
    if (existsSync(target)) {
      const existing = readFileSync(target);
      if (existing.length !== content.length || !existing.equals(content)) {
        throw new HttpError(500, "Existing receipt storage conflicts with the restored backup");
      }
      continue;
    }
    writeFileSync(target, content, { flag: "wx", mode: 0o600 });
  }
}
