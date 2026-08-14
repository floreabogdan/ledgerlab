import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { createMemoryDatabase, type LedgerDatabase } from "@/db";
import { sessions, users, workspaceMembers, workspaces } from "@/db/schema";
import { DEFAULT_UI_LANGUAGE, SUPPORTED_UI_LANGUAGE_TAGS } from "@/i18n/language";
import {
  authenticateUser,
  createSession,
  createUser,
  hashPassword,
  hashSessionToken,
  validateSessionToken,
  validateWorkspaceSessionToken,
  verifyPassword,
} from "@/lib/auth";
import { profilePreferencesInput, registerInput } from "@/lib/validation";

describe("local authentication", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  function memoryDatabase(): LedgerDatabase {
    const memory = createMemoryDatabase();
    close = () => memory.sqlite.close();
    return memory.db;
  }

  it("uses salted scrypt hashes and constant-shape verification", async () => {
    const first = await hashPassword("a long test password");
    const second = await hashPassword("a long test password");
    expect(first).not.toBe(second);
    expect(first.startsWith("scrypt$")).toBe(true);
    await expect(verifyPassword("a long test password", first)).resolves.toBe(true);
    await expect(verifyPassword("the wrong password", first)).resolves.toBe(false);
  });

  it("stores only a session-token digest and expires persistent sessions", async () => {
    const database = memoryDatabase();
    const user = await createUser(
      { email: " Person@Example.Test ", password: "a long test password", displayName: "Person" },
      database,
    );
    expect(user).toMatchObject({
      defaultCurrency: "USD",
      locale: "en-US",
      timeZone: "UTC",
      uiLanguage: DEFAULT_UI_LANGUAGE,
    });
    await expect(authenticateUser("person@example.test", "a long test password", database)).resolves.toMatchObject({
      id: user.id,
      normalizedEmail: "person@example.test",
      uiLanguage: DEFAULT_UI_LANGUAGE,
    });

    const issuedAt = new Date("2026-01-01T00:00:00Z");
    const created = createSession(user.id, {}, database, issuedAt);
    const stored = database.select().from(sessions).get()!;
    expect(stored.tokenHash).toBe(hashSessionToken(created.token));
    expect(stored.tokenHash).not.toContain(created.token);
    expect(validateSessionToken(created.token, database, issuedAt)?.user).toMatchObject({
      uiLanguage: DEFAULT_UI_LANGUAGE,
    });
    expect(validateSessionToken(created.token, database, issuedAt)?.user).not.toHaveProperty("passwordHash");
    expect(validateSessionToken(created.token, database, new Date("2026-02-15T00:00:00Z"))).toBeNull();
    expect(database.select().from(sessions).all()).toHaveLength(0);
  });

  it("persists explicitly selected regional settings without changing existing users", async () => {
    const database = memoryDatabase();
    const selectedUiLanguage = SUPPORTED_UI_LANGUAGE_TAGS.at(-1)!;
    const first = await createUser(
      {
        email: "global@example.test",
        password: "a long test password",
        displayName: "Global user",
        currency: "eur",
        locale: "de-DE",
        timeZone: "Europe/Berlin",
        uiLanguage: selectedUiLanguage,
      },
      database,
    );
    expect(first).toMatchObject({
      defaultCurrency: "EUR",
      locale: "de-DE",
      timeZone: "Europe/Berlin",
      uiLanguage: selectedUiLanguage,
    });

    await expect(createUser({
      email: "invalid-currency@example.test",
      password: "a long test password",
      displayName: "Invalid currency",
      currency: "ZZZ",
    }, database)).rejects.toMatchObject({ code: "INVALID_CURRENCY" });

    await expect(authenticateUser("global@example.test", "a long test password", database))
      .resolves.toMatchObject({
        defaultCurrency: "EUR",
        locale: "de-DE",
        timeZone: "Europe/Berlin",
        uiLanguage: selectedUiLanguage,
      });
  });

  it("normalizes untrusted UI-language values through the generated language registry", async () => {
    const database = memoryDatabase();
    const selectedUiLanguage = SUPPORTED_UI_LANGUAGE_TAGS.at(-1)!;
    const registration = registerInput.parse({
      name: "Language user",
      email: "language@example.test",
      password: "a long test password",
      uiLanguage: selectedUiLanguage,
    });
    expect(registration.uiLanguage).toBe(selectedUiLanguage);

    expect(registerInput.parse({
      name: "Default language",
      email: "default-language@example.test",
      password: "a long test password",
    }).uiLanguage).toBe(DEFAULT_UI_LANGUAGE);

    expect(profilePreferencesInput.parse({
      displayName: "Language user",
      currency: "EUR",
      uiLanguage: "not_a_language",
    }).uiLanguage).toBe(DEFAULT_UI_LANGUAGE);

    await expect(createUser({
      email: "invalid-language@example.test",
      password: "a long test password",
      displayName: "Invalid language",
      uiLanguage: "not_a_language",
    }, database)).resolves.toMatchObject({ uiLanguage: DEFAULT_UI_LANGUAGE });
  });

  it("keeps an English database default for callers that omit UI language", () => {
    const database = memoryDatabase();
    database.insert(users).values({
      id: "legacy-user",
      email: "legacy@example.test",
      normalizedEmail: "legacy@example.test",
      passwordHash: "not-used",
      displayName: "Legacy user",
    }).run();
    database.insert(workspaces).values({
      id: "legacy-user",
      type: "personal",
      name: "Legacy user",
      createdByUserId: "legacy-user",
    }).run();
    database.insert(workspaceMembers).values({
      workspaceId: "legacy-user",
      userId: "legacy-user",
      role: "owner",
    }).run();

    expect(database.select({ uiLanguage: users.uiLanguage }).from(users).get())
      .toEqual({ uiLanguage: "en" });
  });

  it("atomically limits first-user registration to an empty installation", async () => {
    const database = memoryDatabase();
    const first = await createUser({
      email: "owner@example.test",
      password: "a long test password",
      displayName: "Owner",
    }, database, { requireEmptyDatabase: true });
    expect(first).toMatchObject({ email: "owner@example.test", isInstallationAdmin: true });
    expect(database.select().from(workspaces).all()).toEqual([
      expect.objectContaining({
        id: first.id,
        type: "personal",
        defaultCurrency: "USD",
        timeZone: "UTC",
      }),
    ]);
    expect(database.select().from(workspaceMembers).all()).toEqual([
      expect.objectContaining({ workspaceId: first.id, userId: first.id, role: "owner" }),
    ]);

    await expect(createUser({
      email: "second@example.test",
      password: "a long test password",
      displayName: "Second user",
    }, database, { requireEmptyDatabase: true })).rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });
  });

  it("assigns installation administration only to the first created user", async () => {
    const database = memoryDatabase();
    const first = await createUser({
      email: "first@example.test",
      password: "a long test password",
      displayName: "First",
    }, database);
    const second = await createUser({
      email: "second@example.test",
      password: "a long test password",
      displayName: "Second",
    }, database);

    expect(first.isInstallationAdmin).toBe(true);
    expect(second.isInstallationAdmin).toBe(false);
    expect(database.select({ id: users.id }).from(users).where(eq(users.isInstallationAdmin, true)).all())
      .toEqual([{ id: first.id }]);
    expect(database.select().from(workspaces).all()).toHaveLength(2);
    expect(database.select().from(workspaceMembers).all()).toHaveLength(2);
  });

  it("revalidates membership on every request and falls a revoked session back to personal", async () => {
    const database = memoryDatabase();
    const owner = await createUser({
      email: "owner@example.test",
      password: "a long test password",
      displayName: "Owner",
    }, database);
    const member = await createUser({
      email: "member@example.test",
      password: "a long test password",
      displayName: "Member",
    }, database);
    database.insert(workspaces).values({
      id: "household",
      type: "household",
      name: "Household",
      createdByUserId: owner.id,
    }).run();
    database.insert(workspaceMembers).values([
      { workspaceId: "household", userId: owner.id, role: "owner" },
      { workspaceId: "household", userId: member.id, role: "member" },
    ]).run();

    const issuedAt = new Date("2026-01-01T00:00:00Z");
    const created = createSession(member.id, {}, database, issuedAt);
    database.update(sessions)
      .set({ activeWorkspaceId: "household" })
      .where(eq(sessions.id, created.sessionId))
      .run();
    expect(validateWorkspaceSessionToken(created.token, database, issuedAt)?.context).toEqual({
      actorUserId: member.id,
      workspaceId: "household",
      role: "member",
    });

    database.delete(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, "household"),
      eq(workspaceMembers.userId, member.id),
    )).run();
    const revalidated = validateWorkspaceSessionToken(created.token, database, issuedAt);
    expect(revalidated?.context).toEqual({
      actorUserId: member.id,
      workspaceId: member.id,
      role: "owner",
    });
    expect(database.select({ activeWorkspaceId: sessions.activeWorkspaceId }).from(sessions).get())
      .toEqual({ activeWorkspaceId: member.id });
  });
});
