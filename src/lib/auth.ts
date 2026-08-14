import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";

import { db as defaultDb, type LedgerDatabase } from "@/db";
import {
  auditLogs,
  categories,
  sessions,
  users,
  workspaceMembers,
  workspaceInvitations,
  workspaces,
  type User,
} from "@/db/schema";
import type { Translator } from "@/i18n/runtime";
import { resolveConfiguredUiLanguage } from "@/i18n/language";
import {
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  DEFAULT_TIME_ZONE,
  isSupportedCurrency,
  normalizeCurrencyCode,
} from "@/lib/currencies";
import { localizedDefaultCategories } from "@/lib/default-categories";
import type { WorkspaceContext } from "@/lib/workspace-context";

export const SESSION_COOKIE_NAME = "ledgerlab_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DUMMY_PASSWORD_HASH = [
  "scrypt",
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  Buffer.alloc(16).toString("base64url"),
  Buffer.alloc(SCRYPT_KEY_LENGTH).toString("base64url"),
].join("$");

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_CREDENTIALS"
      | "EMAIL_TAKEN"
      | "WEAK_PASSWORD"
      | "INVALID_EMAIL"
      | "INVALID_CURRENCY"
      | "INVALID_LOCALE"
      | "INVALID_TIME_ZONE"
      | "INVITATION_UNAVAILABLE"
      | "REGISTRATION_CLOSED",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function scrypt(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      keyLength,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key as Buffer)),
    );
  });
}

function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase("en-US");
}

function validatePassword(password: string): void {
  const byteLength = Buffer.byteLength(password, "utf8");
  if (byteLength < 10 || byteLength > 1_024) {
    throw new AuthError("Password must be between 10 and 1,024 bytes.", "WEAK_PASSWORD");
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, n, r, p, encodedSalt, encodedKey] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    Number(n) !== SCRYPT_N ||
    Number(r) !== SCRYPT_R ||
    Number(p) !== SCRYPT_P ||
    !encodedSalt ||
    !encodedKey
  ) {
    return false;
  }

  try {
    if (Buffer.byteLength(password, "utf8") > 1_024) return false;
    const salt = Buffer.from(encodedSalt, "base64url");
    const storedKey = Buffer.from(encodedKey, "base64url");
    if (salt.length !== 16 || storedKey.length !== SCRYPT_KEY_LENGTH) return false;
    const candidate = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
    return storedKey.length === candidate.length && timingSafeEqual(storedKey, candidate);
  } catch {
    return false;
  }
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type SafeUser = Omit<User, "passwordHash">;

export type CreateUserInput = {
  email: string;
  password: string;
  displayName: string;
  currency?: string;
  locale?: string;
  timeZone?: string;
  uiLanguage?: string;
};

export type CreateUserOptions = {
  /** Atomically require this user to be the installation's first account. */
  requireEmptyDatabase?: boolean;
  /** Seed the personal workspace in the selected interface language. */
  defaultCategoryTranslator?: Translator;
  invitation?: {
    id: string;
    tokenHash: string;
    workspaceId: string;
    role: "owner" | "member";
  };
};

function toSafeUser(user: User): SafeUser {
  const { passwordHash, ...safeUser } = user;
  void passwordHash;
  return safeUser;
}

export async function createUser(
  input: CreateUserInput,
  database: LedgerDatabase = defaultDb,
  options: CreateUserOptions = {},
): Promise<SafeUser> {
  const normalizedEmail = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new AuthError("Enter a valid email address.", "INVALID_EMAIL");
  }

  const existing = database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.normalizedEmail, normalizedEmail))
    .get();
  if (existing) throw new AuthError("An account with this email already exists.", "EMAIL_TAKEN");

  const defaultCurrency = normalizeCurrencyCode(input.currency ?? DEFAULT_CURRENCY);
  if (!isSupportedCurrency(defaultCurrency)) {
    throw new AuthError("Choose a supported ISO 4217 currency.", "INVALID_CURRENCY");
  }
  let locale: string;
  try {
    locale = new Intl.Locale(input.locale ?? DEFAULT_LOCALE).toString();
  } catch {
    throw new AuthError("Choose a valid locale.", "INVALID_LOCALE");
  }
  const timeZone = input.timeZone?.trim() || DEFAULT_TIME_ZONE;
  try {
    void new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new AuthError("Choose a valid IANA time zone.", "INVALID_TIME_ZONE");
  }
  const uiLanguage = resolveConfiguredUiLanguage(input.uiLanguage);

  const passwordHash = await hashPassword(input.password);
  const now = new Date().toISOString();
  const user: User = {
    id: randomUUID(),
    email: input.email.trim(),
    normalizedEmail,
    passwordHash,
    displayName: input.displayName.trim() || normalizedEmail.split("@")[0]!,
    uiLanguage,
    defaultCurrency,
    locale,
    timeZone,
    demoDataEnabled: false,
    isInstallationAdmin: false,
    createdAt: now,
    updatedAt: now,
  };
  try {
    database.transaction((transaction) => {
      const existingUser = transaction.select({ id: users.id }).from(users).limit(1).get();
      if (options.requireEmptyDatabase) {
        if (existingUser) {
          throw new AuthError("Registration is closed for this installation.", "REGISTRATION_CLOSED");
        }
      }
      user.isInstallationAdmin = !existingUser;
      transaction.insert(users).values(user).run();
      transaction.insert(workspaces).values({
        id: user.id,
        type: "personal",
        name: user.displayName,
        defaultCurrency: user.defaultCurrency,
        timeZone: user.timeZone,
        createdByUserId: user.id,
        createdAt: now,
        updatedAt: now,
      }).run();
      transaction.insert(workspaceMembers).values({
        workspaceId: user.id,
        userId: user.id,
        role: "owner",
        createdAt: now,
      }).run();
      if (options.defaultCategoryTranslator) {
        for (const category of localizedDefaultCategories(options.defaultCategoryTranslator)) {
          const categoryId = randomUUID();
          transaction.insert(categories).values({
            id: categoryId,
            workspaceId: user.id,
            name: category.name,
            kind: category.kind,
            spendingNature: category.spendingNature,
            spendingPriority: category.spendingPriority,
            color: category.color,
            displayOrder: category.displayOrder,
            createdAt: now,
            updatedAt: now,
          }).run();
          transaction.insert(auditLogs).values({
            id: randomUUID(),
            workspaceId: user.id,
            actorUserId: user.id,
            entityType: "category",
            entityId: categoryId,
            action: "create_default",
            after: {
              name: category.name,
              kind: category.kind,
              spendingNature: category.spendingNature,
              spendingPriority: category.spendingPriority,
            },
            createdAt: now,
          }).run();
        }
      }
      if (options.invitation) {
        const invitation = transaction.select({ id: workspaceInvitations.id })
          .from(workspaceInvitations)
          .where(and(
            eq(workspaceInvitations.id, options.invitation.id),
            eq(workspaceInvitations.tokenHash, options.invitation.tokenHash),
            eq(workspaceInvitations.workspaceId, options.invitation.workspaceId),
            eq(workspaceInvitations.normalizedEmail, normalizedEmail),
            isNull(workspaceInvitations.acceptedAt),
            isNull(workspaceInvitations.revokedAt),
            gt(workspaceInvitations.expiresAt, now),
          ))
          .get();
        if (!invitation) {
          throw new AuthError("This invitation is no longer available.", "INVITATION_UNAVAILABLE");
        }
        transaction.insert(workspaceMembers).values({
          workspaceId: options.invitation.workspaceId,
          userId: user.id,
          role: options.invitation.role,
          createdAt: now,
        }).run();
        transaction.update(workspaceInvitations)
          .set({ acceptedAt: now })
          .where(eq(workspaceInvitations.id, options.invitation.id))
          .run();
        transaction.insert(auditLogs).values({
          id: randomUUID(),
          workspaceId: options.invitation.workspaceId,
          actorUserId: user.id,
          entityType: "workspace_invitation",
          entityId: options.invitation.id,
          action: "accept",
          after: { role: options.invitation.role },
          createdAt: now,
        }).run();
      }
    });
  } catch (error) {
    const message = String(error);
    const code = (error as { code?: unknown } | null)?.code;
    if (
      (code === "SQLITE_CONSTRAINT_UNIQUE" && message.includes("normalized_email"))
      || message.includes("users.normalized_email")
      || message.includes("users_normalized_email_unique")
    ) {
      throw new AuthError("An account with this email already exists.", "EMAIL_TAKEN");
    }
    throw error;
  }
  return toSafeUser(user);
}

export async function authenticateUser(
  email: string,
  password: string,
  database: LedgerDatabase = defaultDb,
): Promise<SafeUser> {
  const user = database
    .select()
    .from(users)
    .where(eq(users.normalizedEmail, normalizeEmail(email)))
    .get();
  // Unknown and known accounts both perform the same scrypt work. Combined
  // with one generic response, this avoids the obvious account-timing oracle.
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !passwordMatches) {
    throw new AuthError("Email or password is incorrect.", "INVALID_CREDENTIALS");
  }
  return toSafeUser(user);
}

export type SessionMetadata = { userAgent?: string; ipAddress?: string };

export function createSession(
  userId: string,
  metadata: SessionMetadata = {},
  database: LedgerDatabase = defaultDb,
  now = new Date(),
): { token: string; expiresAt: Date; sessionId: string } {
  const token = randomBytes(32).toString("base64url");
  const sessionId = randomUUID();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  database
    .insert(sessions)
    .values({
      id: sessionId,
      userId,
      activeWorkspaceId: userId,
      tokenHash: hashSessionToken(token),
      expiresAt: expiresAt.toISOString(),
      lastSeenAt: now.toISOString(),
      userAgent: metadata.userAgent,
      ipAddress: metadata.ipAddress,
      createdAt: now.toISOString(),
    })
    .run();
  return { token, expiresAt, sessionId };
}

export type ValidSession = {
  session: typeof sessions.$inferSelect;
  user: SafeUser;
};

export type ValidWorkspaceSession = ValidSession & {
  workspace: typeof workspaces.$inferSelect;
  context: WorkspaceContext;
};

export function validateSessionToken(
  token: string | null | undefined,
  database: LedgerDatabase = defaultDb,
  now = new Date(),
): ValidSession | null {
  if (!token || !SESSION_TOKEN_PATTERN.test(token)) return null;
  const row = database
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, hashSessionToken(token)))
    .get();
  if (!row) return null;

  const expiresAt = Date.parse(row.session.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    database.delete(sessions).where(eq(sessions.id, row.session.id)).run();
    return null;
  }

  // Touch at most hourly, avoiding a write on every request.
  const lastSeenAt = Date.parse(row.session.lastSeenAt);
  if (!Number.isFinite(lastSeenAt) || now.getTime() - lastSeenAt >= 60 * 60 * 1_000) {
    database.update(sessions).set({ lastSeenAt: now.toISOString() }).where(eq(sessions.id, row.session.id)).run();
    row.session.lastSeenAt = now.toISOString();
  }
  return { session: row.session, user: toSafeUser(row.user) };
}

/**
 * Resolves and revalidates workspace membership for each request. The role is
 * never trusted from session state, so removing a member takes effect on their
 * next request even when the identity session itself is still valid.
 */
export function resolveWorkspaceSession(
  valid: ValidSession,
  database: LedgerDatabase = defaultDb,
): ValidWorkspaceSession | null {
  const findMembership = (workspaceId: string) => database
    .select({ workspace: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(
      eq(workspaceMembers.userId, valid.user.id),
      eq(workspaceMembers.workspaceId, workspaceId),
    ))
    .get();

  const requestedWorkspaceId = valid.session.activeWorkspaceId ?? valid.user.id;
  let membership = findMembership(requestedWorkspaceId);
  if (!membership && requestedWorkspaceId !== valid.user.id) {
    membership = findMembership(valid.user.id);
    if (membership) {
      database.update(sessions)
        .set({ activeWorkspaceId: valid.user.id })
        .where(eq(sessions.id, valid.session.id))
        .run();
      valid.session.activeWorkspaceId = valid.user.id;
    }
  }
  if (!membership) return null;

  return {
    ...valid,
    workspace: membership.workspace,
    context: {
      actorUserId: valid.user.id,
      workspaceId: membership.workspace.id,
      role: membership.role,
    },
  };
}

export function validateWorkspaceSessionToken(
  token: string | null | undefined,
  database: LedgerDatabase = defaultDb,
  now = new Date(),
): ValidWorkspaceSession | null {
  const valid = validateSessionToken(token, database, now);
  return valid ? resolveWorkspaceSession(valid, database) : null;
}

export function revokeSession(token: string, database: LedgerDatabase = defaultDb): void {
  database.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token))).run();
}

export function readSessionToken(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = pair.trim().split("=");
    if (rawName === SESSION_COOKIE_NAME) {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function serializeSessionCookie(token: string, expiresAt: Date, secure = process.env.NODE_ENV === "production"): string {
  const secureFlag = secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secureFlag}`;
}

export function serializeExpiredSessionCookie(secure = process.env.NODE_ENV === "production"): string {
  return serializeSessionCookie("", new Date(0), secure);
}
