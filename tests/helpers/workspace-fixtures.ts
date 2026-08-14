import type BetterSqlite3 from "better-sqlite3";

import type { WorkspaceContext, WorkspaceRole } from "@/lib/workspace-context";

export type TestUserOptions = {
  id: string;
  email?: string;
  displayName?: string;
  currency?: string;
  locale?: string;
  timeZone?: string;
  uiLanguage?: string;
  passwordHash?: string;
  isInstallationAdmin?: boolean;
};

/**
 * Inserts a complete test identity. Production user creation always creates the
 * matching personal workspace and owner membership atomically, so raw SQL test
 * fixtures must model the same invariant.
 */
export function insertTestUser(
  connection: BetterSqlite3.Database,
  options: TestUserOptions,
): void {
  const email = options.email ?? `${options.id}@example.test`;
  const displayName = options.displayName ?? options.id;
  const currency = options.currency ?? "USD";
  const locale = options.locale ?? "en-US";
  const timeZone = options.timeZone ?? "UTC";
  const uiLanguage = options.uiLanguage ?? "en";

  connection.transaction(() => {
    connection.prepare(`INSERT INTO users
      (id, email, normalized_email, password_hash, display_name, ui_language,
       default_currency, locale, time_zone, is_installation_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        options.id,
        email,
        email.trim().toLocaleLowerCase("en-US"),
        options.passwordHash ?? "unused",
        displayName,
        uiLanguage,
        currency,
        locale,
        timeZone,
        options.isInstallationAdmin ? 1 : 0,
      );
    connection.prepare(`INSERT INTO workspaces
      (id, type, name, default_currency, time_zone, created_by_user_id)
      VALUES (?, 'personal', ?, ?, ?, ?)`)
      .run(options.id, displayName, currency, timeZone, options.id);
    connection.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (?, ?, 'owner')`)
      .run(options.id, options.id);
  })();
}

export function workspaceContext(
  actorUserId: string,
  workspaceId = actorUserId,
  role: WorkspaceRole = "owner",
): WorkspaceContext {
  return { actorUserId, workspaceId, role };
}
