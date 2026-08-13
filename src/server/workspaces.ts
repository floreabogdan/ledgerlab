import { createHash, randomBytes, randomUUID } from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import type { Translator } from "@/i18n/runtime";
import { HttpError, type ApiErrorParameters } from "@/lib/api-response";
import { isSupportedCurrency, normalizeCurrencyCode } from "@/lib/currencies";
import {
  requireWorkspaceOwner,
  type WorkspaceContext,
  type WorkspaceRole,
  type WorkspaceType,
} from "@/lib/workspace-context";
import { createDefaultCategories, database } from "@/server/core";

const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MIN_INVITATION_TTL_MS = 5 * 60 * 1_000;
const MAX_INVITATION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

type SqlValue = string | number | bigint | Buffer | null;

export type WorkspaceSummary = Readonly<{
  id: string;
  type: WorkspaceType;
  name: string;
  defaultCurrency: string;
  timeZone: string;
  role: WorkspaceRole;
  memberCount: number;
  active: boolean;
}>;

export type WorkspaceMemberSummary = Readonly<{
  userId: string;
  displayName: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: string;
}>;

export type WorkspaceInvitationSummary = Readonly<{
  id: string;
  email: string;
  role: WorkspaceRole;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
}>;

export type WorkspaceActivitySummary = Readonly<{
  id: string;
  actorDisplayName: string | null;
  entityType: string;
  action: string;
  createdAt: string;
}>;

export type InvitationRegistrationClaim = Readonly<{
  invitationId: string;
  workspaceId: string;
  workspaceName: string;
  normalizedEmail: string;
  role: WorkspaceRole;
  expiresAt: string;
}>;

type WorkspaceRow = {
  id: string;
  type: WorkspaceType;
  name: string;
  defaultCurrency: string;
  timeZone: string;
};

type InvitationRow = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceType: WorkspaceType;
  normalizedEmail: string;
  role: WorkspaceRole;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

function workspaceError(
  status: number,
  code: string,
  message: string,
  params?: ApiErrorParameters,
) {
  return new HttpError(status, { code, message, params });
}

function connection(): BetterSqlite3.Database {
  return database();
}

function one<T>(sql: string, values: SqlValue[] = []): T | undefined {
  return connection().prepare(sql).get(...values) as T | undefined;
}

function all<T>(sql: string, values: SqlValue[] = []): T[] {
  return connection().prepare(sql).all(...values) as T[];
}

function runImmediate<T>(operation: () => T): T {
  return connection().transaction(operation).immediate();
}

function workspaceName(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80) {
    throw workspaceError(422, "WORKSPACE_NAME_INVALID", "Workspace names must contain between 1 and 80 characters", {
      minCharacters: 1,
      maxCharacters: 80,
    });
  }
  return normalized;
}

function workspaceCurrency(value: string) {
  const normalized = normalizeCurrencyCode(value);
  if (!isSupportedCurrency(normalized)) {
    throw workspaceError(422, "WORKSPACE_CURRENCY_INVALID", "Choose a supported ISO 4217 currency");
  }
  return normalized;
}

function workspaceTimeZone(value: string) {
  const normalized = value.trim();
  try {
    void new Intl.DateTimeFormat("en", { timeZone: normalized });
  } catch {
    throw workspaceError(422, "WORKSPACE_TIME_ZONE_INVALID", "Choose a valid IANA time zone");
  }
  return normalized;
}

export function normalizeWorkspaceEmail(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (
    normalized.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw workspaceError(422, "INVITATION_EMAIL_INVALID", "Enter a valid email address");
  }
  return normalized;
}

export function hashWorkspaceInvitationToken(token: string): string {
  if (!INVITATION_TOKEN_PATTERN.test(token)) {
    throw workspaceError(404, "INVITATION_NOT_FOUND", "Invitation not found");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function role(value: string): WorkspaceRole {
  if (value !== "owner" && value !== "member") {
    throw workspaceError(422, "WORKSPACE_ROLE_INVALID", "Choose an owner or member role");
  }
  return value;
}

function storedWorkspace(workspaceId: string): WorkspaceRow {
  const workspace = one<WorkspaceRow>(
    `SELECT id, type, name, default_currency AS defaultCurrency, time_zone AS timeZone
       FROM workspaces WHERE id = ?`,
    [workspaceId],
  );
  if (!workspace) throw workspaceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  return workspace;
}

function assertHousehold(workspaceId: string): WorkspaceRow {
  const workspace = storedWorkspace(workspaceId);
  if (workspace.type !== "household") {
    throw workspaceError(422, "WORKSPACE_HOUSEHOLD_REQUIRED", "This action is available only for household workspaces");
  }
  return workspace;
}

function assertCurrentOwner(context: WorkspaceContext): WorkspaceRow {
  requireWorkspaceOwner(context);
  const workspace = assertHousehold(context.workspaceId);
  const current = one<{ role: WorkspaceRole }>(
    "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    [context.workspaceId, context.actorUserId],
  );
  if (current?.role !== "owner") {
    throw workspaceError(403, "WORKSPACE_OWNER_REQUIRED", "Workspace owner access is required");
  }
  return workspace;
}

function ownerCount(workspaceId: string) {
  return one<{ count: number }>(
    "SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND role = 'owner'",
    [workspaceId],
  )?.count ?? 0;
}

function audit(
  context: WorkspaceContext,
  entityType: string,
  entityId: string,
  action: string,
  before?: unknown,
  after?: unknown,
) {
  connection().prepare(
    `INSERT INTO audit_logs
      (id, workspace_id, actor_user_id, entity_type, entity_id, action, before, after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    context.workspaceId,
    context.actorUserId,
    entityType,
    entityId,
    action,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
  );
}

function contextFor(actorUserId: string, workspaceId: string, workspaceRole: WorkspaceRole): WorkspaceContext {
  return { actorUserId, workspaceId, role: workspaceRole };
}

/**
 * Provision the one-member personal workspace belonging to a newly inserted
 * user. Callers may invoke this inside their user-creation transaction; nested
 * better-sqlite transactions use a savepoint and preserve atomic registration.
 */
export function provisionPersonalWorkspace(
  input: {
    userId: string;
    name: string;
    defaultCurrency: string;
    timeZone: string;
  },
  translator: Translator,
) {
  const id = input.userId;
  const name = workspaceName(input.name);
  const defaultCurrency = workspaceCurrency(input.defaultCurrency);
  const timeZone = workspaceTimeZone(input.timeZone);
  const now = new Date().toISOString();
  return runImmediate(() => {
    const inserted = connection().prepare(
      `INSERT OR IGNORE INTO workspaces
        (id, type, name, default_currency, time_zone, created_by_user_id, created_at, updated_at)
       VALUES (?, 'personal', ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, defaultCurrency, timeZone, input.userId, now, now);
    connection().prepare(
      `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
       VALUES (?, ?, 'owner', ?)`,
    ).run(id, input.userId, now);
    if (inserted.changes === 1) {
      createDefaultCategories(contextFor(input.userId, id, "owner"), translator);
    }
    return storedWorkspace(id);
  });
}

export function createHouseholdWorkspace(
  context: WorkspaceContext,
  input: { name: string; defaultCurrency: string; timeZone: string },
  translator: Translator,
) {
  const id = randomUUID();
  const name = workspaceName(input.name);
  const defaultCurrency = workspaceCurrency(input.defaultCurrency);
  const timeZone = workspaceTimeZone(input.timeZone);
  const now = new Date().toISOString();
  return runImmediate(() => {
    connection().prepare(
      `INSERT INTO workspaces
        (id, type, name, default_currency, time_zone, created_by_user_id, created_at, updated_at)
       VALUES (?, 'household', ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, defaultCurrency, timeZone, context.actorUserId, now, now);
    connection().prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       VALUES (?, ?, 'owner', ?)`,
    ).run(id, context.actorUserId, now);
    const householdContext = contextFor(context.actorUserId, id, "owner");
    createDefaultCategories(householdContext, translator);
    audit(householdContext, "workspace", id, "create", undefined, {
      type: "household",
      name,
      defaultCurrency,
      timeZone,
    });
    return storedWorkspace(id);
  });
}

export function listUserWorkspaces(userId: string, activeWorkspaceId?: string | null): WorkspaceSummary[] {
  const rows = all<Omit<WorkspaceSummary, "active"> & { memberCount: number }>(
    `SELECT w.id, w.type, w.name, w.default_currency AS defaultCurrency,
            w.time_zone AS timeZone, m.role,
            (SELECT COUNT(*) FROM workspace_members count_members
              WHERE count_members.workspace_id = w.id) AS memberCount
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ?
      ORDER BY CASE w.type WHEN 'personal' THEN 0 ELSE 1 END, lower(w.name), w.id`,
    [userId],
  );
  return rows.map((workspace) => ({
    ...workspace,
    memberCount: Number(workspace.memberCount),
    active: workspace.id === activeWorkspaceId,
  }));
}

export function resolveSessionWorkspace(userId: string, sessionId: string) {
  const current = one<WorkspaceSummary>(
    `SELECT w.id, w.type, w.name, w.default_currency AS defaultCurrency,
            w.time_zone AS timeZone, m.role, 0 AS memberCount, 1 AS active
       FROM sessions s
       JOIN workspace_members m
         ON m.workspace_id = s.active_workspace_id AND m.user_id = s.user_id
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE s.id = ? AND s.user_id = ?`,
    [sessionId, userId],
  );
  if (current) return { ...current, memberCount: Number(current.memberCount), active: true };

  const fallback = one<WorkspaceSummary>(
    `SELECT w.id, w.type, w.name, w.default_currency AS defaultCurrency,
            w.time_zone AS timeZone, m.role, 0 AS memberCount, 1 AS active
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ?
      ORDER BY CASE WHEN w.id = ? THEN 0 WHEN w.type = 'personal' THEN 1 ELSE 2 END,
               lower(w.name), w.id
      LIMIT 1`,
    [userId, userId],
  );
  if (!fallback) {
    throw workspaceError(403, "WORKSPACE_MEMBERSHIP_REQUIRED", "No accessible workspace is available");
  }
  const changed = connection().prepare(
    "UPDATE sessions SET active_workspace_id = ? WHERE id = ? AND user_id = ?",
  ).run(fallback.id, sessionId, userId);
  if (changed.changes !== 1) {
    throw workspaceError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue");
  }
  return { ...fallback, memberCount: Number(fallback.memberCount), active: true };
}

export function activateWorkspace(userId: string, sessionId: string, workspaceId: string) {
  const workspace = one<WorkspaceSummary>(
    `SELECT w.id, w.type, w.name, w.default_currency AS defaultCurrency,
            w.time_zone AS timeZone, m.role,
            (SELECT COUNT(*) FROM workspace_members count_members
              WHERE count_members.workspace_id = w.id) AS memberCount,
            1 AS active
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ? AND m.workspace_id = ?`,
    [userId, workspaceId],
  );
  if (!workspace) throw workspaceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  const changed = connection().prepare(
    "UPDATE sessions SET active_workspace_id = ? WHERE id = ? AND user_id = ?",
  ).run(workspaceId, sessionId, userId);
  if (changed.changes !== 1) {
    throw workspaceError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue");
  }
  return { ...workspace, memberCount: Number(workspace.memberCount), active: true };
}

function invitationByToken(token: string): InvitationRow {
  const tokenHash = hashWorkspaceInvitationToken(token);
  const invitation = one<InvitationRow>(
    `SELECT i.id, i.workspace_id AS workspaceId, w.name AS workspaceName,
            w.type AS workspaceType, i.normalized_email AS normalizedEmail,
            i.role, i.expires_at AS expiresAt, i.accepted_at AS acceptedAt,
            i.revoked_at AS revokedAt, i.created_at AS createdAt
       FROM workspace_invitations i
       JOIN workspaces w ON w.id = i.workspace_id
      WHERE i.token_hash = ?`,
    [tokenHash],
  );
  if (!invitation) throw workspaceError(404, "INVITATION_NOT_FOUND", "Invitation not found");
  return invitation;
}

function pendingInvitation(token: string, now: Date): InvitationRow {
  const invitation = invitationByToken(token);
  if (invitation.workspaceType !== "household") {
    throw workspaceError(404, "INVITATION_NOT_FOUND", "Invitation not found");
  }
  if (invitation.revokedAt) {
    throw workspaceError(410, "INVITATION_REVOKED", "This invitation was revoked");
  }
  if (invitation.acceptedAt) {
    throw workspaceError(409, "INVITATION_ALREADY_ACCEPTED", "This invitation has already been used");
  }
  if (Date.parse(invitation.expiresAt) <= now.getTime()) {
    throw workspaceError(410, "INVITATION_EXPIRED", "This invitation has expired");
  }
  return invitation;
}

function maskEmail(email: string) {
  const [local = "", domain = ""] = email.split("@");
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(3, Math.min(8, local.length - visible.length)))}@${domain}`;
}

export function inspectWorkspaceInvitation(token: string, now = new Date()) {
  const invitation = pendingInvitation(token, now);
  return {
    workspaceName: invitation.workspaceName,
    emailHint: maskEmail(invitation.normalizedEmail),
    expiresAt: invitation.expiresAt,
    role: invitation.role,
  } as const;
}

export function resolveInvitationRegistrationClaim(
  token: string,
  email: string,
  now = new Date(),
): InvitationRegistrationClaim {
  const invitation = pendingInvitation(token, now);
  const normalizedEmail = normalizeWorkspaceEmail(email);
  if (normalizedEmail !== invitation.normalizedEmail) {
    throw workspaceError(403, "INVITATION_EMAIL_MISMATCH", "Sign in or register with the email address that received this invitation");
  }
  return {
    invitationId: invitation.id,
    workspaceId: invitation.workspaceId,
    workspaceName: invitation.workspaceName,
    normalizedEmail,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
  };
}

export function createWorkspaceInvitation(
  context: WorkspaceContext,
  input: { email: string; role?: WorkspaceRole; expiresInMs?: number },
  options: { now?: Date; tokenFactory?: () => string } = {},
) {
  assertCurrentOwner(context);
  const normalizedEmail = normalizeWorkspaceEmail(input.email);
  const invitationRole = role(input.role ?? "member");
  const ttl = input.expiresInMs ?? DEFAULT_INVITATION_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < MIN_INVITATION_TTL_MS || ttl > MAX_INVITATION_TTL_MS) {
    throw workspaceError(422, "INVITATION_EXPIRY_INVALID", "Choose an invitation expiry between 5 minutes and 30 days");
  }
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttl).toISOString();
  const token = options.tokenFactory?.() ?? randomBytes(32).toString("base64url");
  const tokenHash = hashWorkspaceInvitationToken(token);
  const id = randomUUID();

  return runImmediate(() => {
    assertCurrentOwner(context);
    const existingMember = one<{ userId: string }>(
      `SELECT m.user_id AS userId
         FROM users u
         JOIN workspace_members m ON m.user_id = u.id
        WHERE u.normalized_email = ? AND m.workspace_id = ?`,
      [normalizedEmail, context.workspaceId],
    );
    if (existingMember) {
      throw workspaceError(409, "INVITATION_ALREADY_MEMBER", "This person is already a household member");
    }
    connection().prepare(
      `UPDATE workspace_invitations SET revoked_at = ?
        WHERE workspace_id = ? AND normalized_email = ?
          AND accepted_at IS NULL AND revoked_at IS NULL`,
    ).run(createdAt, context.workspaceId, normalizedEmail);
    connection().prepare(
      `INSERT INTO workspace_invitations
        (id, workspace_id, normalized_email, token_hash, role, expires_at,
         created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      context.workspaceId,
      normalizedEmail,
      tokenHash,
      invitationRole,
      expiresAt,
      context.actorUserId,
      createdAt,
    );
    audit(context, "workspace_invitation", id, "create", undefined, {
      role: invitationRole,
      expiresAt,
    });
    return {
      invitation: {
        id,
        email: normalizedEmail,
        role: invitationRole,
        status: "pending" as const,
        expiresAt,
        createdAt,
      },
      token,
    };
  });
}

export function listWorkspaceInvitations(
  context: WorkspaceContext,
  now = new Date(),
): WorkspaceInvitationSummary[] {
  assertCurrentOwner(context);
  const rows = all<{
    id: string;
    normalizedEmail: string;
    role: WorkspaceRole;
    expiresAt: string;
    acceptedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  }>(
    `SELECT id, normalized_email AS normalizedEmail, role, expires_at AS expiresAt,
            accepted_at AS acceptedAt, revoked_at AS revokedAt, created_at AS createdAt
       FROM workspace_invitations
      WHERE workspace_id = ?
      ORDER BY created_at DESC, id DESC`,
    [context.workspaceId],
  );
  return rows.map((invitation) => ({
    id: invitation.id,
    email: invitation.normalizedEmail,
    role: invitation.role,
    status: invitation.acceptedAt
      ? "accepted"
      : invitation.revokedAt
        ? "revoked"
        : Date.parse(invitation.expiresAt) <= now.getTime()
          ? "expired"
          : "pending",
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
  }));
}

export function revokeWorkspaceInvitation(context: WorkspaceContext, invitationId: string, now = new Date()) {
  assertCurrentOwner(context);
  return runImmediate(() => {
    assertCurrentOwner(context);
    const current = one<{ id: string; acceptedAt: string | null; revokedAt: string | null }>(
      `SELECT id, accepted_at AS acceptedAt, revoked_at AS revokedAt
         FROM workspace_invitations WHERE id = ? AND workspace_id = ?`,
      [invitationId, context.workspaceId],
    );
    if (!current) throw workspaceError(404, "INVITATION_NOT_FOUND", "Invitation not found");
    if (current.acceptedAt) {
      throw workspaceError(409, "INVITATION_ALREADY_ACCEPTED", "This invitation has already been used");
    }
    if (!current.revokedAt) {
      connection().prepare(
        `UPDATE workspace_invitations SET revoked_at = ?
          WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`,
      ).run(now.toISOString(), invitationId, context.workspaceId);
      audit(context, "workspace_invitation", invitationId, "revoke");
    }
    return { revoked: true, id: invitationId } as const;
  });
}

function acceptWorkspaceInvitationInTransaction(token: string, userId: string, now: Date) {
  const invitation = pendingInvitation(token, now);
  const user = one<{ normalizedEmail: string }>(
    "SELECT normalized_email AS normalizedEmail FROM users WHERE id = ?",
    [userId],
  );
  if (!user) throw workspaceError(404, "INVITATION_USER_NOT_FOUND", "User not found");
  if (user.normalizedEmail !== invitation.normalizedEmail) {
    throw workspaceError(403, "INVITATION_EMAIL_MISMATCH", "Sign in or register with the email address that received this invitation");
  }
  const acceptedAt = now.toISOString();
  const changed = connection().prepare(
    `UPDATE workspace_invitations SET accepted_at = ?
      WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
  ).run(acceptedAt, invitation.id, acceptedAt);
  if (changed.changes !== 1) {
    // Re-resolve to return the correct stable conflict without consuming twice.
    pendingInvitation(token, now);
    throw workspaceError(409, "INVITATION_ALREADY_ACCEPTED", "This invitation has already been used");
  }
  connection().prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, user_id) DO NOTHING`,
  ).run(invitation.workspaceId, userId, invitation.role, acceptedAt);
  const membership = one<{ role: WorkspaceRole }>(
    "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    [invitation.workspaceId, userId],
  );
  const acceptedContext = contextFor(userId, invitation.workspaceId, membership?.role ?? invitation.role);
  audit(acceptedContext, "workspace_invitation", invitation.id, "accept", undefined, {
    role: membership?.role ?? invitation.role,
  });
  return {
    workspace: storedWorkspace(invitation.workspaceId),
    role: membership?.role ?? invitation.role,
  } as const;
}

/**
 * Consume an invitation while the caller's registration transaction is open.
 * The caller must already have inserted `userId` and its personal workspace.
 */
export function acceptWorkspaceInvitationInCurrentTransaction(
  token: string,
  userId: string,
  now = new Date(),
) {
  if (!connection().inTransaction) {
    throw new Error("acceptWorkspaceInvitationInCurrentTransaction requires an active database transaction");
  }
  return acceptWorkspaceInvitationInTransaction(token, userId, now);
}

export function acceptWorkspaceInvitation(token: string, userId: string, now = new Date()) {
  return runImmediate(() => acceptWorkspaceInvitationInTransaction(token, userId, now));
}

export function listWorkspaceMembers(context: WorkspaceContext): WorkspaceMemberSummary[] {
  assertHousehold(context.workspaceId);
  return all<WorkspaceMemberSummary>(
    `SELECT u.id AS userId, u.display_name AS displayName, u.email, m.role,
            m.created_at AS joinedAt
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, lower(u.display_name), u.id`,
    [context.workspaceId],
  );
}

export function listWorkspaceActivity(
  context: WorkspaceContext,
  limit = 50,
): WorkspaceActivitySummary[] {
  assertHousehold(context.workspaceId);
  const normalizedLimit = Number.isSafeInteger(limit)
    ? Math.min(Math.max(limit, 1), 100)
    : 50;
  return all<WorkspaceActivitySummary>(
    `SELECT logs.id, users.display_name AS actorDisplayName,
            logs.entity_type AS entityType, logs.action, logs.created_at AS createdAt
       FROM audit_logs logs
       LEFT JOIN users ON users.id = logs.actor_user_id
      WHERE logs.workspace_id = ?
      ORDER BY logs.created_at DESC, logs.rowid DESC
      LIMIT ?`,
    [context.workspaceId, normalizedLimit],
  );
}

function storedMember(workspaceId: string, userId: string) {
  const member = one<WorkspaceMemberSummary>(
    `SELECT u.id AS userId, u.display_name AS displayName, u.email, m.role,
            m.created_at AS joinedAt
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND m.user_id = ?`,
    [workspaceId, userId],
  );
  if (!member) throw workspaceError(404, "WORKSPACE_MEMBER_NOT_FOUND", "Household member not found");
  return member;
}

function assertMayRemoveOwner(workspaceId: string, currentRole: WorkspaceRole) {
  if (currentRole === "owner" && ownerCount(workspaceId) <= 1) {
    throw workspaceError(409, "WORKSPACE_LAST_OWNER_REQUIRED", "Transfer ownership before removing the household's last owner");
  }
}

function fallbackSessions(userId: string, removedWorkspaceId: string) {
  connection().prepare(
    `UPDATE sessions SET active_workspace_id = ?
      WHERE user_id = ? AND active_workspace_id = ?`,
  ).run(userId, userId, removedWorkspaceId);
}

export function setWorkspaceMemberRole(
  context: WorkspaceContext,
  userId: string,
  nextRole: WorkspaceRole,
) {
  assertCurrentOwner(context);
  const normalizedRole = role(nextRole);
  return runImmediate(() => {
    assertCurrentOwner(context);
    const member = storedMember(context.workspaceId, userId);
    if (member.role === normalizedRole) return member;
    if (member.role === "owner" && normalizedRole === "member") {
      assertMayRemoveOwner(context.workspaceId, member.role);
    }
    connection().prepare(
      "UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?",
    ).run(normalizedRole, context.workspaceId, userId);
    audit(context, "workspace_member", userId, normalizedRole === "owner" ? "promote" : "demote", {
      role: member.role,
    }, { role: normalizedRole });
    return storedMember(context.workspaceId, userId);
  });
}

export function transferWorkspaceOwnership(context: WorkspaceContext, userId: string) {
  assertCurrentOwner(context);
  if (userId === context.actorUserId) {
    throw workspaceError(422, "WORKSPACE_TRANSFER_SELF_INVALID", "Choose another household member for ownership transfer");
  }
  return runImmediate(() => {
    assertCurrentOwner(context);
    const target = storedMember(context.workspaceId, userId);
    connection().prepare(
      "UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?",
    ).run(context.workspaceId, userId);
    connection().prepare(
      "UPDATE workspace_members SET role = 'member' WHERE workspace_id = ? AND user_id = ?",
    ).run(context.workspaceId, context.actorUserId);
    audit(context, "workspace", context.workspaceId, "transfer_ownership", {
      ownerUserId: context.actorUserId,
    }, { ownerUserId: userId, previousTargetRole: target.role });
    return {
      previousOwner: storedMember(context.workspaceId, context.actorUserId),
      owner: storedMember(context.workspaceId, userId),
    } as const;
  });
}

export function removeWorkspaceMember(context: WorkspaceContext, userId: string) {
  assertCurrentOwner(context);
  return runImmediate(() => {
    assertCurrentOwner(context);
    const member = storedMember(context.workspaceId, userId);
    assertMayRemoveOwner(context.workspaceId, member.role);
    connection().prepare(
      "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).run(context.workspaceId, userId);
    fallbackSessions(userId, context.workspaceId);
    audit(context, "workspace_member", userId, "remove", { role: member.role });
    return { removed: true, userId } as const;
  });
}

export function leaveWorkspace(context: WorkspaceContext) {
  assertHousehold(context.workspaceId);
  return runImmediate(() => {
    const member = storedMember(context.workspaceId, context.actorUserId);
    assertMayRemoveOwner(context.workspaceId, member.role);
    audit(context, "workspace_member", context.actorUserId, "leave", { role: member.role });
    connection().prepare(
      "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).run(context.workspaceId, context.actorUserId);
    fallbackSessions(context.actorUserId, context.workspaceId);
    return { left: true, workspaceId: context.workspaceId } as const;
  });
}

export function deleteHouseholdWorkspace(context: WorkspaceContext, confirmation: string) {
  const workspace = assertCurrentOwner(context);
  if (confirmation.trim() !== workspace.name) {
    throw workspaceError(422, "WORKSPACE_DELETE_CONFIRMATION_INVALID", "Enter the household name exactly to confirm deletion");
  }
  return runImmediate(() => {
    const current = assertCurrentOwner(context);
    const members = all<{ userId: string }>(
      "SELECT user_id AS userId FROM workspace_members WHERE workspace_id = ?",
      [context.workspaceId],
    );
    for (const member of members) fallbackSessions(member.userId, context.workspaceId);
    audit(context, "workspace", context.workspaceId, "delete", current);
    const deleted = connection().prepare(
      "DELETE FROM workspaces WHERE id = ? AND type = 'household'",
    ).run(context.workspaceId);
    if (deleted.changes !== 1) throw workspaceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    return { deleted: true, id: current.id } as const;
  });
}

export function workspaceManagement(context: WorkspaceContext, now = new Date()) {
  const workspace = storedWorkspace(context.workspaceId);
  return {
    actorUserId: context.actorUserId,
    workspace: {
      ...workspace,
      role: context.role,
    },
    members: workspace.type === "household" ? listWorkspaceMembers(context) : [],
    activity: workspace.type === "household" ? listWorkspaceActivity(context) : [],
    invitations: workspace.type === "household" && context.role === "owner"
      ? listWorkspaceInvitations(context, now)
      : [],
  };
}
