import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { messageCatalogs } from "@/i18n/generated";
import { createTranslator } from "@/i18n/runtime";

type DatabaseModule = typeof import("@/db");
type AuthModule = typeof import("@/lib/auth");
type WorkspaceModule = typeof import("@/server/workspaces");

let db: DatabaseModule;
let auth: AuthModule;
let workspaceService: WorkspaceModule;
const originalDatabaseUrl = process.env.DATABASE_URL;

const english = createTranslator({ language: "en", catalog: messageCatalogs.en });
const romanian = createTranslator({
  language: "ro",
  formattingLocale: "ro-RO",
  timeZone: "Europe/Bucharest",
  catalog: messageCatalogs.ro,
  fallbackCatalog: messageCatalogs.en,
  fallbackLanguage: "en",
});

function ownerContext(actorUserId: string, workspaceId: string) {
  return { actorUserId, workspaceId, role: "owner" as const };
}

function memberContext(actorUserId: string, workspaceId: string) {
  return { actorUserId, workspaceId, role: "member" as const };
}

function thrown(operation: () => unknown) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw");
}

async function user(email: string, displayName: string) {
  return auth.createUser({
    email,
    password: "a long test password",
    displayName,
    currency: "RON",
    locale: "ro-RO",
    timeZone: "Europe/Bucharest",
  }, db.db);
}

beforeAll(async () => {
  process.env.DATABASE_URL = ":memory:";
  vi.resetModules();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown })
    .__ledgerLabConnection;
  db = await import("@/db");
  auth = await import("@/lib/auth");
  workspaceService = await import("@/server/workspaces");
  db.ensureDatabase();
});

beforeEach(() => {
  db.sqlite.exec(`
    DELETE FROM audit_logs;
    DELETE FROM workspaces WHERE type = 'household';
    DELETE FROM users;
  `);
});

afterAll(() => {
  db.sqlite.close();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown })
    .__ledgerLabConnection;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("workspace provisioning", () => {
  it("creates a private workspace whose id matches its user and seeds localized defaults", () => {
    db.sqlite.prepare(`INSERT INTO users
      (id, email, normalized_email, password_hash, display_name, ui_language,
       default_currency, locale, time_zone, is_installation_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "romanian-user",
        "familie@example.test",
        "familie@example.test",
        "unused",
        "Familia Ionescu",
        "ro",
        "RON",
        "ro-RO",
        "Europe/Bucharest",
        1,
      );

    const workspace = workspaceService.provisionPersonalWorkspace({
      userId: "romanian-user",
      name: "Familia Ionescu",
      defaultCurrency: "RON",
      timeZone: "Europe/Bucharest",
    }, romanian);

    expect(workspace).toMatchObject({
      id: "romanian-user",
      type: "personal",
      name: "Familia Ionescu",
      defaultCurrency: "RON",
      timeZone: "Europe/Bucharest",
    });
    expect(db.sqlite.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).pluck().get("romanian-user", "romanian-user")).toBe("owner");
    expect(db.sqlite.prepare(
      "SELECT name FROM categories WHERE workspace_id = ? ORDER BY display_order",
    ).pluck().all("romanian-user")).toContain("Salariu");
  });

  it("creates, lists, activates, and safely falls back from an inaccessible household", async () => {
    const owner = await user("owner@example.test", "Owner");
    const remainingOwner = await user("remaining@example.test", "Remaining owner");
    const session = auth.createSession(owner.id, {}, db.db, new Date("2026-08-01T00:00:00Z"));
    const household = workspaceService.createHouseholdWorkspace(
      ownerContext(owner.id, owner.id),
      { name: "Home", defaultCurrency: "EUR", timeZone: "Europe/Bucharest" },
      english,
    );

    expect(workspaceService.listUserWorkspaces(owner.id, owner.id)).toEqual([
      expect.objectContaining({ id: owner.id, type: "personal", active: true }),
      expect.objectContaining({ id: household.id, type: "household", active: false, memberCount: 1 }),
    ]);
    expect(workspaceService.activateWorkspace(owner.id, session.sessionId, household.id))
      .toMatchObject({ id: household.id, role: "owner", active: true });

    // Simulate membership removal by another owner. Session resolution must
    // never preserve access merely because the session still names a workspace.
    db.sqlite.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')",
    ).run(household.id, remainingOwner.id);
    db.sqlite.prepare(
      "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    ).run(household.id, owner.id);
    expect(workspaceService.resolveSessionWorkspace(owner.id, session.sessionId))
      .toMatchObject({ id: owner.id, type: "personal", role: "owner" });
    expect(db.sqlite.prepare(
      "SELECT active_workspace_id FROM sessions WHERE id = ?",
    ).pluck().get(session.sessionId)).toBe(owner.id);
  });
});

describe("workspace invitations", () => {
  it("stores only a digest and consumes an email-bound invitation exactly once", async () => {
    const owner = await user("owner@example.test", "Owner");
    const invitee = await user("invitee@example.test", "Invitee");
    const household = workspaceService.createHouseholdWorkspace(
      ownerContext(owner.id, owner.id),
      { name: "Our home", defaultCurrency: "RON", timeZone: "Europe/Bucharest" },
      english,
    );
    const context = ownerContext(owner.id, household.id);
    const rawToken = "A".repeat(43);
    const created = workspaceService.createWorkspaceInvitation(
      context,
      { email: " Invitee@Example.Test ", role: "member" },
      { now: new Date("2026-08-01T10:00:00Z"), tokenFactory: () => rawToken },
    );

    expect(created.token).toBe(rawToken);
    expect(created.invitation.email).toBe("invitee@example.test");
    const stored = db.sqlite.prepare(
      "SELECT token_hash AS tokenHash FROM workspace_invitations WHERE id = ?",
    ).get(created.invitation.id) as { tokenHash: string };
    expect(stored.tokenHash).toBe(workspaceService.hashWorkspaceInvitationToken(rawToken));
    expect(JSON.stringify(stored)).not.toContain(rawToken);
    expect(JSON.stringify(db.sqlite.prepare(
      "SELECT before, after FROM audit_logs WHERE entity_id = ?",
    ).get(created.invitation.id))).not.toContain("invitee@example.test");
    expect(workspaceService.inspectWorkspaceInvitation(rawToken, new Date("2026-08-02T10:00:00Z")))
      .toMatchObject({ workspaceName: "Our home", role: "member" });

    expect(thrown(() => workspaceService.acceptWorkspaceInvitation(
      rawToken,
      owner.id,
      new Date("2026-08-02T10:00:00Z"),
    ))).toMatchObject({ status: 403, code: "INVITATION_EMAIL_MISMATCH" });

    expect(workspaceService.acceptWorkspaceInvitation(
      rawToken,
      invitee.id,
      new Date("2026-08-02T10:00:00Z"),
    )).toMatchObject({ workspace: { id: household.id }, role: "member" });
    expect(thrown(() => workspaceService.acceptWorkspaceInvitation(
      rawToken,
      invitee.id,
      new Date("2026-08-02T10:00:01Z"),
    ))).toMatchObject({ status: 409, code: "INVITATION_ALREADY_ACCEPTED" });
  });

  it("rejects expired and revoked links and supersedes pending links for the same email", async () => {
    const owner = await user("owner@example.test", "Owner");
    const household = workspaceService.createHouseholdWorkspace(
      ownerContext(owner.id, owner.id),
      { name: "Household", defaultCurrency: "RON", timeZone: "UTC" },
      english,
    );
    const context = ownerContext(owner.id, household.id);
    const firstToken = "B".repeat(43);
    const first = workspaceService.createWorkspaceInvitation(
      context,
      { email: "guest@example.test" },
      { now: new Date("2026-08-01T00:00:00Z"), tokenFactory: () => firstToken },
    );
    const secondToken = "C".repeat(43);
    const second = workspaceService.createWorkspaceInvitation(
      context,
      { email: "guest@example.test" },
      { now: new Date("2026-08-01T01:00:00Z"), tokenFactory: () => secondToken },
    );

    expect(thrown(() => workspaceService.inspectWorkspaceInvitation(
      firstToken,
      new Date("2026-08-01T02:00:00Z"),
    ))).toMatchObject({ status: 410, code: "INVITATION_REVOKED" });
    workspaceService.revokeWorkspaceInvitation(context, second.invitation.id);
    expect(thrown(() => workspaceService.inspectWorkspaceInvitation(secondToken)))
      .toMatchObject({ status: 410, code: "INVITATION_REVOKED" });

    const expiryToken = "D".repeat(43);
    workspaceService.createWorkspaceInvitation(
      context,
      { email: "later@example.test", expiresInMs: 5 * 60 * 1_000 },
      { now: new Date("2026-08-01T00:00:00Z"), tokenFactory: () => expiryToken },
    );
    expect(thrown(() => workspaceService.inspectWorkspaceInvitation(
      expiryToken,
      new Date("2026-08-01T00:05:00Z"),
    ))).toMatchObject({ status: 410, code: "INVITATION_EXPIRED" });
    expect(first.invitation.id).not.toBe(second.invitation.id);
  });
});

describe("household membership lifecycle", () => {
  it("enforces the last-owner rule and transfers active sessions to personal workspaces", async () => {
    const owner = await user("owner@example.test", "Owner");
    const member = await user("member@example.test", "Member");
    const household = workspaceService.createHouseholdWorkspace(
      ownerContext(owner.id, owner.id),
      { name: "Family", defaultCurrency: "RON", timeZone: "Europe/Bucharest" },
      english,
    );
    const ownerCtx = ownerContext(owner.id, household.id);
    const token = "E".repeat(43);
    workspaceService.createWorkspaceInvitation(
      ownerCtx,
      { email: member.email, role: "member" },
      { tokenFactory: () => token },
    );
    workspaceService.acceptWorkspaceInvitation(token, member.id);

    expect(thrown(() => workspaceService.setWorkspaceMemberRole(ownerCtx, owner.id, "member")))
      .toMatchObject({ status: 409, code: "WORKSPACE_LAST_OWNER_REQUIRED" });
    expect(thrown(() => workspaceService.leaveWorkspace(ownerCtx)))
      .toMatchObject({ status: 409, code: "WORKSPACE_LAST_OWNER_REQUIRED" });

    const session = auth.createSession(owner.id, {}, db.db);
    workspaceService.activateWorkspace(owner.id, session.sessionId, household.id);
    const transferred = workspaceService.transferWorkspaceOwnership(ownerCtx, member.id);
    expect(transferred).toMatchObject({
      previousOwner: { userId: owner.id, role: "member" },
      owner: { userId: member.id, role: "owner" },
    });
    expect(thrown(() => workspaceService.removeWorkspaceMember(ownerCtx, member.id)))
      .toMatchObject({ status: 403, code: "WORKSPACE_OWNER_REQUIRED" });

    expect(workspaceService.leaveWorkspace(memberContext(owner.id, household.id)))
      .toEqual({ left: true, workspaceId: household.id });
    expect(db.sqlite.prepare(
      "SELECT active_workspace_id FROM sessions WHERE id = ?",
    ).pluck().get(session.sessionId)).toBe(owner.id);
    expect(workspaceService.listWorkspaceMembers(ownerContext(member.id, household.id)))
      .toEqual([expect.objectContaining({ userId: member.id, role: "owner" })]);
  });

  it("requires an exact name before deleting a household and resets member sessions", async () => {
    const owner = await user("owner@example.test", "Owner");
    const session = auth.createSession(owner.id, {}, db.db);
    const household = workspaceService.createHouseholdWorkspace(
      ownerContext(owner.id, owner.id),
      { name: "Shared bills", defaultCurrency: "EUR", timeZone: "Europe/Bucharest" },
      english,
    );
    const context = ownerContext(owner.id, household.id);
    workspaceService.activateWorkspace(owner.id, session.sessionId, household.id);

    expect(thrown(() => workspaceService.deleteHouseholdWorkspace(context, "shared bills")))
      .toMatchObject({ status: 422, code: "WORKSPACE_DELETE_CONFIRMATION_INVALID" });
    expect(workspaceService.deleteHouseholdWorkspace(context, "Shared bills"))
      .toEqual({ deleted: true, id: household.id });
    expect(db.sqlite.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(household.id))
      .toBeUndefined();
    expect(db.sqlite.prepare(
      "SELECT active_workspace_id FROM sessions WHERE id = ?",
    ).pluck().get(session.sessionId)).toBe(owner.id);
  });
});
