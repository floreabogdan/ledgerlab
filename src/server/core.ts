import { createHash, randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";

import { ensureDatabase, sqlite } from "@/db";
import { HttpError } from "@/lib/api-response";
import { isSupportedCurrency, normalizeCurrencyCode } from "@/lib/currencies";
import {
  convertMinorAtRate,
  findPersistedBnrQuote,
  prepareTransactionFx,
  type TransactionFxFields,
  validateTransactionFxForPosting,
  validateTransferFxForPosting,
} from "@/server/fx";
import { getUserCalendarContext, getUserRegionalSettings } from "@/server/user-settings";

type SqlValue = string | number | bigint | Buffer | null;

export function database(): BetterSqlite3.Database {
  ensureDatabase();
  return sqlite;
}

export function all<T>(sql: string, params: SqlValue[] = []): T[] {
  return database().prepare(sql).all(...params) as T[];
}

export function one<T>(sql: string, params: SqlValue[] = []): T | undefined {
  return database().prepare(sql).get(...params) as T | undefined;
}

export function audit(
  userId: string,
  entityType: string,
  entityId: string,
  action: string,
  before?: unknown,
  after?: unknown,
) {
  database()
    .prepare(
      `INSERT INTO audit_logs (id, user_id, entity_type, entity_id, action, before, after)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      userId,
      entityType,
      entityId,
      action,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
    );
}

const DEFAULT_CATEGORIES = [
  ["Salary", "income", null, null, "#24735c"],
  ["Other income", "income", null, null, "#3d8b73"],
  ["Housing", "expense", "fixed", "essential", "#7656a5"],
  ["Utilities", "expense", "fixed", "essential", "#4f6f8f"],
  ["Groceries", "expense", "variable", "essential", "#d0803f"],
  ["Transport", "expense", "variable", "essential", "#3f7f91"],
  ["Health", "expense", "variable", "essential", "#b45364"],
  ["Education", "expense", "variable", "essential", "#5369a5"],
  ["Dining", "expense", "variable", "discretionary", "#d05f54"],
  ["Shopping", "expense", "variable", "discretionary", "#a85f91"],
  ["Entertainment", "expense", "variable", "discretionary", "#85724a"],
  ["Travel", "expense", "variable", "discretionary", "#487c74"],
] as const;

export function createDefaultCategories(userId: string) {
  const statement = database().prepare(
    `INSERT OR IGNORE INTO categories
      (id, user_id, name, kind, spending_nature, spending_priority, color, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  database().transaction(() => {
    DEFAULT_CATEGORIES.forEach(([name, kind, nature, priority, color], index) => {
      statement.run(randomUUID(), userId, name, kind, nature, priority, color, index);
    });
  })();
}

interface AccountRow {
  id: string;
  name: string;
  type: string;
  customType: string | null;
  currency: string;
  openingBalanceMinor: number;
  openingDate: string;
  creditLimitMinor: number | null;
  institution: string | null;
  color: string | null;
  archivedAt: string | null;
  balanceMinor: number;
  pendingMinor: number;
}

export function listAccounts(userId: string, includeArchived = false): AccountRow[] {
  return all<AccountRow>(
    `SELECT a.id, a.name, a.type, a.custom_type AS customType, a.currency,
            a.opening_balance_minor AS openingBalanceMinor,
            a.opening_balance_date AS openingDate, a.credit_limit_minor AS creditLimitMinor,
            a.institution, a.color, a.archived_at AS archivedAt,
            a.opening_balance_minor + COALESCE(SUM(
              CASE WHEN t.status = 'cleared' AND t.voided_at IS NULL
                         AND substr(t.occurred_at, 1, 10) >= a.opening_balance_date
                   THEN t.amount_minor ELSE 0 END
            ), 0) AS balanceMinor,
            COALESCE(SUM(CASE WHEN t.status = 'pending' AND t.voided_at IS NULL
                                       AND substr(t.occurred_at, 1, 10) >= a.opening_balance_date
                              THEN t.amount_minor ELSE 0 END), 0) AS pendingMinor
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
      WHERE a.user_id = ? ${includeArchived ? "" : "AND a.archived_at IS NULL"}
      GROUP BY a.id
      ORDER BY a.display_order, a.name`,
    [userId],
  );
}

interface AccountInput {
  name: string;
  type: string;
  customType?: string | null;
  currency?: string;
  openingBalanceMinor?: number;
  openingDate: string;
  creditLimitMinor?: number | null;
  institution?: string | null;
  color?: string;
}

export function createAccount(userId: string, input: AccountInput) {
  const regionalSettings = getUserCalendarContext(userId);
  if (input.openingDate > regionalSettings.today) {
    throw new HttpError(422, "Account opening date cannot be in the future");
  }
  const currency = normalizeCurrencyCode(input.currency ?? regionalSettings.currency);
  if (!isSupportedCurrency(currency)) throw new HttpError(422, "Choose a supported ISO 4217 currency");
  const id = randomUUID();
  const order = one<{ nextOrder: number }>(
    "SELECT COALESCE(MAX(display_order), -1) + 1 AS nextOrder FROM accounts WHERE user_id = ?",
    [userId],
  )?.nextOrder ?? 0;
  try {
    database()
      .prepare(
        `INSERT INTO accounts
          (id, user_id, name, type, custom_type, currency, opening_balance_minor,
           opening_balance_date, credit_limit_minor, institution, color, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        input.name,
        input.type,
        input.customType ?? null,
        currency,
        input.openingBalanceMinor ?? 0,
        input.openingDate,
        input.creditLimitMinor ?? null,
        input.institution ?? null,
        input.color ?? "#2563eb",
        order,
      );
  } catch (error) {
    const message = String(error);
    if (message.includes("accounts_user_name_unique") || message.includes("accounts.user_id, accounts.name")) {
      throw new HttpError(409, "An account with this name already exists");
    }
    throw error;
  }
  audit(userId, "account", id, "create", undefined, input);
  return listAccounts(userId, true).find((account) => account.id === id);
}

export function updateAccount(userId: string, accountId: string, input: Record<string, unknown>) {
  const previous = one<Record<string, unknown>>("SELECT * FROM accounts WHERE id = ? AND user_id = ?", [accountId, userId]);
  if (!previous) throw new HttpError(404, "Account not found");
  if (input.currency !== undefined) {
    if (typeof input.currency !== "string") throw new HttpError(422, "Account currency must be an ISO 4217 code");
    const currency = normalizeCurrencyCode(input.currency);
    if (!isSupportedCurrency(currency)) throw new HttpError(422, "Choose a supported ISO 4217 currency");
    if (currency !== normalizeCurrencyCode(String(previous.currency ?? ""))) {
      throw new HttpError(409, "An account currency cannot be changed after creation; create a new account and transfer the balance instead");
    }
    input = { ...input, currency };
  }
  if (input.openingDate !== undefined) {
    if (typeof input.openingDate !== "string") throw new HttpError(422, "Account opening date must be a date");
    if (input.openingDate > getUserCalendarContext(userId).today) throw new HttpError(422, "Account opening date cannot be in the future");
  }

  const mapping: Record<string, string> = {
    name: "name",
    type: "type",
    customType: "custom_type",
    currency: "currency",
    openingBalanceMinor: "opening_balance_minor",
    openingDate: "opening_balance_date",
    creditLimitMinor: "credit_limit_minor",
    institution: "institution",
    color: "color",
  };
  const assignments: string[] = [];
  const params: SqlValue[] = [];
  for (const [key, column] of Object.entries(mapping)) {
    if (input[key] !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(input[key] as SqlValue);
    }
  }
  if (typeof input.archived === "boolean") {
    assignments.push("archived_at = ?");
    params.push(input.archived ? new Date().toISOString() : null);
  }
  if (!assignments.length) return listAccounts(userId, true).find((account) => account.id === accountId);
  assignments.push("updated_at = CURRENT_TIMESTAMP");
  params.push(accountId, userId);
  database().prepare(`UPDATE accounts SET ${assignments.join(", ")} WHERE id = ? AND user_id = ?`).run(...params);
  audit(userId, "account", accountId, "update", previous, input);
  return listAccounts(userId, true).find((account) => account.id === accountId);
}

const MAX_CATEGORY_DEPTH = 31;
const CATEGORY_KINDS = ["income", "expense", "both"] as const;
type CategoryKind = (typeof CATEGORY_KINDS)[number];

export interface CategoryRow {
  id: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
  kind: CategoryKind;
  spendingNature: string | null;
  spendingPriority: string | null;
  color: string | null;
  archivedAt: string | null;
  displayOrder: number;
  depth: number;
  path: string;
  ancestorIds: string[];
  hasChildren: boolean;
}

export function listCategories(userId: string, includeArchived = false): CategoryRow[] {
  interface CategoryQueryRow extends Omit<CategoryRow, "ancestorIds" | "hasChildren"> {
    ancestorIdsRaw: string;
    hasChildren: number;
  }
  const activeRoot = includeArchived ? "" : "AND c.archived_at IS NULL";
  const activeChild = includeArchived ? "" : "AND child.archived_at IS NULL";
  const activeDescendant = includeArchived ? "" : "AND descendant.archived_at IS NULL";
  const rows = all<CategoryQueryRow>(
    `WITH RECURSIVE category_tree AS (
       SELECT c.id, c.user_id AS userId, c.name, c.parent_id AS parentId,
              NULL AS parentName, c.kind, c.spending_nature AS spendingNature,
              c.spending_priority AS spendingPriority, c.color,
              c.archived_at AS archivedAt, c.display_order AS displayOrder,
              0 AS depth, c.name AS path, '' AS ancestorIdsRaw,
              ',' || c.id || ',' AS lineage,
              printf('%010d:%s:%s', c.display_order, lower(c.name), c.id) AS sortPath
         FROM categories c
        WHERE c.user_id = ? AND c.parent_id IS NULL ${activeRoot}
       UNION ALL
       SELECT child.id, child.user_id, child.name, child.parent_id,
              tree.name, child.kind, child.spending_nature,
              child.spending_priority, child.color, child.archived_at,
              child.display_order, tree.depth + 1,
              tree.path || ' › ' || child.name,
              CASE WHEN tree.ancestorIdsRaw = '' THEN tree.id
                   ELSE tree.ancestorIdsRaw || ',' || tree.id END,
              tree.lineage || child.id || ',',
              tree.sortPath || '/' || printf('%010d:%s:%s', child.display_order, lower(child.name), child.id)
         FROM categories child
         JOIN category_tree tree ON tree.id = child.parent_id AND tree.userId = child.user_id
        WHERE tree.depth < ${MAX_CATEGORY_DEPTH}
          AND instr(tree.lineage, ',' || child.id || ',') = 0 ${activeChild}
     )
     SELECT tree.id, tree.name, tree.parentId, tree.parentName, tree.kind,
            tree.spendingNature, tree.spendingPriority, tree.color, tree.archivedAt,
            tree.displayOrder, tree.depth, tree.path, tree.ancestorIdsRaw,
            EXISTS (
              SELECT 1 FROM categories descendant
               WHERE descendant.user_id = tree.userId AND descendant.parent_id = tree.id
                     ${activeDescendant}
            ) AS hasChildren
       FROM category_tree tree
      ORDER BY tree.sortPath COLLATE NOCASE`,
    [userId],
  );
  return rows.map(({ ancestorIdsRaw, hasChildren, ...category }) => ({
    ...category,
    ancestorIds: ancestorIdsRaw ? ancestorIdsRaw.split(",") : [],
    hasChildren: Boolean(hasChildren),
  }));
}

export interface CategoryInput {
  name: string;
  parentId?: string | null;
  kind?: CategoryKind;
  classification?: string;
  spendingNature?: "fixed" | "variable" | null;
  spendingPriority?: "essential" | "discretionary" | null;
  color?: string;
}

export interface CategoryUpdateInput {
  name?: string;
  parentId?: string | null;
  kind?: CategoryKind;
  classification?: string;
  spendingNature?: "fixed" | "variable" | null;
  spendingPriority?: "essential" | "discretionary" | null;
  color?: string;
}

interface StoredCategory {
  id: string;
  name: string;
  parentId: string | null;
  kind: CategoryKind;
  spendingNature: "fixed" | "variable" | null;
  spendingPriority: "essential" | "discretionary" | null;
  color: string | null;
  archivedAt: string | null;
}

function storedCategory(userId: string, categoryId: string) {
  return one<StoredCategory>(
    `SELECT id, name, parent_id AS parentId, kind,
            spending_nature AS spendingNature, spending_priority AS spendingPriority,
            color, archived_at AS archivedAt
       FROM categories WHERE id = ? AND user_id = ?`,
    [categoryId, userId],
  );
}

function normalizeCategoryName(name: string) {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80) {
    throw new HttpError(422, "Category name must be between 1 and 80 characters");
  }
  return normalized;
}

function assertCategoryKind(kind: string): asserts kind is CategoryKind {
  if (!(CATEGORY_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(422, "Choose an income, expense, or income-and-expense category type");
  }
}

function assertCategoryAttributes(input: CategoryInput | CategoryUpdateInput) {
  if (input.kind !== undefined) assertCategoryKind(input.kind);
  if (input.classification !== undefined && !["fixed", "variable", "essential", "discretionary"].includes(input.classification)) {
    throw new HttpError(422, "Choose a valid category classification");
  }
  if (input.spendingNature !== undefined && input.spendingNature !== null && !["fixed", "variable"].includes(input.spendingNature)) {
    throw new HttpError(422, "Choose fixed or variable spending");
  }
  if (input.spendingPriority !== undefined && input.spendingPriority !== null && !["essential", "discretionary"].includes(input.spendingPriority)) {
    throw new HttpError(422, "Choose essential or discretionary spending");
  }
  if (input.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(input.color)) {
    throw new HttpError(422, "Category colour must be a six-digit hex value");
  }
}

function parentAllowsKind(parentKind: CategoryKind, childKind: CategoryKind) {
  return parentKind === "both" || parentKind === childKind;
}

function categoryDepth(userId: string, categoryId: string) {
  const result = one<{ depth: number; cycle: number }>(
    `WITH RECURSIVE ancestors(id, parentId, depth, lineage, cycle) AS (
       SELECT id, parent_id, 0, ',' || id || ',', 0
         FROM categories WHERE id = ? AND user_id = ?
       UNION ALL
       SELECT parent.id, parent.parent_id, ancestors.depth + 1,
              ancestors.lineage || parent.id || ',',
              instr(ancestors.lineage, ',' || parent.id || ',') > 0
         FROM categories parent
         JOIN ancestors ON parent.id = ancestors.parentId
        WHERE parent.user_id = ? AND ancestors.depth <= ${MAX_CATEGORY_DEPTH}
          AND ancestors.cycle = 0
     )
     SELECT MAX(depth) AS depth, MAX(cycle) AS cycle FROM ancestors`,
    [categoryId, userId, userId],
  );
  if (!result) throw new HttpError(422, "Parent category not found");
  if (result.cycle || result.depth > MAX_CATEGORY_DEPTH) throw new HttpError(422, "The category hierarchy is invalid");
  return result.depth;
}

function categorySubtreeHeight(userId: string, categoryId: string) {
  const result = one<{ height: number; cycle: number }>(
    `WITH RECURSIVE descendants(id, depth, lineage, cycle) AS (
       SELECT id, 0, ',' || id || ',', 0
         FROM categories WHERE id = ? AND user_id = ?
       UNION ALL
       SELECT child.id, descendants.depth + 1,
              descendants.lineage || child.id || ',',
              instr(descendants.lineage, ',' || child.id || ',') > 0
         FROM categories child
         JOIN descendants ON child.parent_id = descendants.id
        WHERE child.user_id = ? AND descendants.depth <= ${MAX_CATEGORY_DEPTH}
          AND descendants.cycle = 0
     )
     SELECT MAX(depth) AS height, MAX(cycle) AS cycle FROM descendants`,
    [categoryId, userId, userId],
  );
  if (!result) throw new HttpError(404, "Category not found");
  if (result.cycle || result.height > MAX_CATEGORY_DEPTH) throw new HttpError(422, "The category hierarchy is invalid");
  return result.height;
}

function assertCategoryParent(
  userId: string,
  parentId: string | null | undefined,
  childKind: CategoryKind,
  movingCategoryId?: string,
  subtreeHeight = 0,
  allowArchivedParent = false,
) {
  if (!parentId) {
    if (subtreeHeight > MAX_CATEGORY_DEPTH) throw new HttpError(422, "Category nesting is too deep");
    return;
  }
  if (parentId === movingCategoryId) throw new HttpError(422, "A category cannot be its own parent");
  const parent = storedCategory(userId, parentId);
  if (!parent) throw new HttpError(422, "Parent category not found");
  if (parent.archivedAt && !allowArchivedParent) throw new HttpError(422, "Restore the parent category before nesting under it");
  if (!parentAllowsKind(parent.kind, childKind)) {
    throw new HttpError(422, `A ${childKind} category cannot be nested under a ${parent.kind} category`);
  }
  if (movingCategoryId) {
    const descendant = one<{ id: string }>(
      `WITH RECURSIVE descendants(id, lineage) AS (
         SELECT id, ',' || id || ',' FROM categories WHERE parent_id = ? AND user_id = ?
         UNION ALL
         SELECT child.id, descendants.lineage || child.id || ','
           FROM categories child JOIN descendants ON child.parent_id = descendants.id
          WHERE child.user_id = ? AND instr(descendants.lineage, ',' || child.id || ',') = 0
       )
       SELECT id FROM descendants WHERE id = ? LIMIT 1`,
      [movingCategoryId, userId, userId, parentId],
    );
    if (descendant) throw new HttpError(422, "A category cannot be moved inside one of its descendants");
  }
  const resultingDepth = categoryDepth(userId, parentId) + 1 + subtreeHeight;
  if (resultingDepth > MAX_CATEGORY_DEPTH) {
    throw new HttpError(422, `Categories can be nested up to ${MAX_CATEGORY_DEPTH + 1} levels deep`);
  }
}

function assertUniqueCategoryName(userId: string, name: string, parentId: string | null, exceptId?: string) {
  const duplicate = one<{ id: string }>(
    `SELECT id FROM categories
      WHERE user_id = ? AND name = ? COLLATE NOCASE
        AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)
        ${exceptId ? "AND id <> ?" : ""}`,
    exceptId ? [userId, name, parentId, parentId, exceptId] : [userId, name, parentId, parentId],
  );
  if (duplicate) throw new HttpError(409, "A category with this name already exists at that level");
}

export function createCategory(userId: string, input: CategoryInput) {
  assertCategoryAttributes(input);
  const name = normalizeCategoryName(input.name);
  const kind = input.kind ?? "expense";
  const parentId = input.parentId ?? null;
  assertCategoryParent(userId, parentId, kind);
  assertUniqueCategoryName(userId, name, parentId);
  const id = randomUUID();
  const nature = input.spendingNature ??
    (input.classification === "fixed" || input.classification === "variable" ? input.classification : null);
  const priority = input.spendingPriority ??
    (input.classification === "essential" || input.classification === "discretionary" ? input.classification : null);
  database()
    .prepare(
      `INSERT INTO categories
        (id, user_id, parent_id, name, kind, spending_nature, spending_priority, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, parentId, name, kind, nature, priority, input.color ?? "#718096");
  audit(userId, "category", id, "create", undefined, { ...input, name, spendingNature: nature, spendingPriority: priority });
  return listCategories(userId, true).find((category) => category.id === id);
}

export function updateCategory(userId: string, categoryId: string, input: CategoryUpdateInput) {
  const previous = storedCategory(userId, categoryId);
  if (!previous) throw new HttpError(404, "Category not found");
  assertCategoryAttributes(input);

  const name = input.name === undefined ? previous.name : normalizeCategoryName(input.name);
  const parentId = input.parentId === undefined ? previous.parentId : input.parentId;
  const kind = input.kind ?? previous.kind;
  const subtreeHeight = categorySubtreeHeight(userId, categoryId);
  assertCategoryParent(
    userId,
    parentId,
    kind,
    categoryId,
    subtreeHeight,
    parentId === previous.parentId,
  );
  assertUniqueCategoryName(userId, name, parentId, categoryId);

  const incompatibleChild = one<{ id: string }>(
    `WITH RECURSIVE descendants(id, kind, lineage) AS (
       SELECT id, kind, ',' || id || ',' FROM categories WHERE user_id = ? AND parent_id = ?
       UNION ALL
       SELECT child.id, child.kind, descendants.lineage || child.id || ','
         FROM categories child JOIN descendants ON child.parent_id = descendants.id
        WHERE child.user_id = ? AND instr(descendants.lineage, ',' || child.id || ',') = 0
     )
     SELECT id FROM descendants
      WHERE NOT (? = 'both' OR kind = ?)
      LIMIT 1`,
    [userId, categoryId, userId, kind, kind],
  );
  if (incompatibleChild) {
    throw new HttpError(422, "Change or move the incompatible subcategories before changing this category type");
  }

  const nature = input.spendingNature !== undefined
    ? input.spendingNature
    : input.classification === "fixed" || input.classification === "variable"
      ? input.classification
      : previous.spendingNature;
  const priority = input.spendingPriority !== undefined
    ? input.spendingPriority
    : input.classification === "essential" || input.classification === "discretionary"
      ? input.classification
      : previous.spendingPriority;
  const color = input.color ?? previous.color;
  database().prepare(
    `UPDATE categories
        SET name = ?, parent_id = ?, kind = ?, spending_nature = ?,
            spending_priority = ?, color = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?`,
  ).run(name, parentId, kind, nature, priority, color, categoryId, userId);
  const updated = listCategories(userId, true).find((category) => category.id === categoryId);
  audit(userId, "category", categoryId, "update", previous, updated);
  return updated;
}

export function setCategoryArchived(userId: string, categoryId: string, archived: boolean) {
  const previous = storedCategory(userId, categoryId);
  if (!previous) throw new HttpError(404, "Category not found");
  if (archived) {
    const activeDescendant = one<{ id: string }>(
      `WITH RECURSIVE descendants(id, lineage) AS (
         SELECT id, ',' || id || ',' FROM categories WHERE user_id = ? AND parent_id = ?
         UNION ALL
         SELECT child.id, descendants.lineage || child.id || ','
           FROM categories child JOIN descendants ON child.parent_id = descendants.id
          WHERE child.user_id = ? AND instr(descendants.lineage, ',' || child.id || ',') = 0
       )
       SELECT c.id FROM descendants JOIN categories c ON c.id = descendants.id
        WHERE c.archived_at IS NULL LIMIT 1`,
      [userId, categoryId, userId],
    );
    if (activeDescendant) throw new HttpError(422, "Archive or move the active subcategories before archiving their parent");
  }
  if (!archived && previous.parentId) {
    const unavailableAncestor = one<{ id: string }>(
      `WITH RECURSIVE ancestors(id, parentId, archivedAt, lineage) AS (
         SELECT id, parent_id, archived_at, ',' || id || ','
           FROM categories WHERE id = ? AND user_id = ?
         UNION ALL
         SELECT parent.id, parent.parent_id, parent.archived_at,
                ancestors.lineage || parent.id || ','
           FROM categories parent JOIN ancestors ON parent.id = ancestors.parentId
          WHERE parent.user_id = ? AND instr(ancestors.lineage, ',' || parent.id || ',') = 0
       )
       SELECT id FROM ancestors
        WHERE archivedAt IS NOT NULL
           OR (parentId IS NOT NULL AND (
             instr(lineage, ',' || parentId || ',') > 0
             OR NOT EXISTS (
               SELECT 1 FROM categories parent
                WHERE parent.id = ancestors.parentId AND parent.user_id = ?
             )
           ))
       LIMIT 1`,
      [previous.parentId, userId, userId, userId],
    );
    if (unavailableAncestor) throw new HttpError(422, "Restore the parent categories first");
  }
  const archivedAt = archived ? new Date().toISOString() : null;
  database().prepare("UPDATE categories SET archived_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
    .run(archivedAt, categoryId, userId);
  audit(userId, "category", categoryId, archived ? "archive" : "restore", previous, { archivedAt });
  return listCategories(userId, true).find((category) => category.id === categoryId);
}

export interface ManagedTagRow {
  id: string;
  name: string;
  color: string | null;
  archivedAt: string | null;
  usageCount: number;
}

export function listTags(userId: string, includeArchived = false): ManagedTagRow[] {
  return all<ManagedTagRow>(
    `SELECT tg.id, tg.name, tg.color, tg.archived_at AS archivedAt,
            COUNT(DISTINCT CASE WHEN tr.status <> 'void' THEN tr.id END) AS usageCount
       FROM tags tg
       LEFT JOIN transaction_tags tt ON tt.tag_id = tg.id
       LEFT JOIN transactions tr ON tr.id = tt.transaction_id AND tr.user_id = tg.user_id
      WHERE tg.user_id = ? ${includeArchived ? "" : "AND tg.archived_at IS NULL"}
      GROUP BY tg.id
      ORDER BY tg.name COLLATE NOCASE`,
    [userId],
  );
}

function cleanTagName(value: string) {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 40) throw new HttpError(422, "Tag name must be between 1 and 40 characters");
  if (name.includes(",")) throw new HttpError(422, "Tag names cannot contain commas because commas separate tags");
  return name;
}

function assertTagNameAvailable(userId: string, name: string, exceptId?: string) {
  const duplicate = one<{ id: string; archivedAt: string | null }>(
    `SELECT id, archived_at AS archivedAt FROM tags
      WHERE user_id = ? AND name = ? COLLATE NOCASE ${exceptId ? "AND id <> ?" : ""}`,
    exceptId ? [userId, name, exceptId] : [userId, name],
  );
  if (duplicate) {
    throw new HttpError(409, duplicate.archivedAt ? "An archived tag already uses this name; restore it instead" : "This tag already exists");
  }
}

export function createTag(userId: string, input: { name: string; color?: string | null }) {
  const name = cleanTagName(input.name);
  assertTagNameAvailable(userId, name);
  const id = randomUUID();
  database().prepare("INSERT INTO tags (id, user_id, name, color) VALUES (?, ?, ?, ?)")
    .run(id, userId, name, input.color ?? "#2563eb");
  audit(userId, "tag", id, "create", undefined, { name, color: input.color ?? "#2563eb" });
  return listTags(userId, true).find((tag) => tag.id === id);
}

export function updateTag(userId: string, tagId: string, input: { name: string; color?: string | null }) {
  const previous = one<ManagedTagRow>(
    "SELECT id, name, color, archived_at AS archivedAt, 0 AS usageCount FROM tags WHERE id = ? AND user_id = ?",
    [tagId, userId],
  );
  if (!previous) throw new HttpError(404, "Tag not found");
  const name = cleanTagName(input.name);
  assertTagNameAvailable(userId, name, tagId);
  database().prepare("UPDATE tags SET name = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
    .run(name, input.color ?? previous.color, tagId, userId);
  audit(userId, "tag", tagId, "update", previous, { name, color: input.color ?? previous.color });
  return listTags(userId, true).find((tag) => tag.id === tagId);
}

export function setTagArchived(userId: string, tagId: string, archived: boolean) {
  const previous = one<ManagedTagRow>(
    "SELECT id, name, color, archived_at AS archivedAt, 0 AS usageCount FROM tags WHERE id = ? AND user_id = ?",
    [tagId, userId],
  );
  if (!previous) throw new HttpError(404, "Tag not found");
  const archivedAt = archived ? new Date().toISOString() : null;
  database().prepare("UPDATE tags SET archived_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
    .run(archivedAt, tagId, userId);
  audit(userId, "tag", tagId, archived ? "archive" : "restore", previous, { archivedAt });
  return listTags(userId, true).find((tag) => tag.id === tagId);
}

export interface ManagedMerchantRow {
  id: string;
  name: string;
  defaultCategoryId: string | null;
  defaultCategoryName: string | null;
  archivedAt: string | null;
  transactionCount: number;
}

export function listMerchants(userId: string, includeArchived = false): ManagedMerchantRow[] {
  return all<ManagedMerchantRow>(
    `SELECT m.id, m.name, m.default_category_id AS defaultCategoryId,
            c.name AS defaultCategoryName, m.archived_at AS archivedAt,
            COUNT(DISTINCT CASE WHEN tr.status <> 'void' THEN tr.id END) AS transactionCount
       FROM merchants m
       LEFT JOIN categories c ON c.id = m.default_category_id AND c.user_id = m.user_id
       LEFT JOIN transactions tr ON tr.merchant_id = m.id AND tr.user_id = m.user_id
      WHERE m.user_id = ? ${includeArchived ? "" : "AND m.archived_at IS NULL"}
      GROUP BY m.id
      ORDER BY m.name COLLATE NOCASE`,
    [userId],
  );
}

export function updateMerchant(
  userId: string,
  merchantId: string,
  input: { name?: string; defaultCategoryId?: string | null },
) {
  const previous = one<ManagedMerchantRow>(
    `SELECT m.id, m.name, m.default_category_id AS defaultCategoryId,
            c.name AS defaultCategoryName, m.archived_at AS archivedAt, 0 AS transactionCount
       FROM merchants m LEFT JOIN categories c ON c.id = m.default_category_id
      WHERE m.id = ? AND m.user_id = ?`,
    [merchantId, userId],
  );
  if (!previous) throw new HttpError(404, "Merchant not found");
  const name = (input.name ?? previous.name).trim().replace(/\s+/g, " ");
  if (!name || name.length > 120) throw new HttpError(422, "Merchant name must be between 1 and 120 characters");
  const normalizedName = normalizeMerchant(name);
  const duplicate = one<{ id: string }>(
    "SELECT id FROM merchants WHERE user_id = ? AND normalized_name = ? AND id <> ?",
    [userId, normalizedName, merchantId],
  );
  if (duplicate) throw new HttpError(409, "Another merchant already uses this name");
  const defaultCategoryId = input.defaultCategoryId === undefined ? previous.defaultCategoryId : input.defaultCategoryId;
  if (defaultCategoryId) {
    assertOwnedCategory(userId, defaultCategoryId, false, "expense");
  }
  database().prepare(
    "UPDATE merchants SET name = ?, normalized_name = ?, default_category_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?",
  ).run(name, normalizedName, defaultCategoryId, merchantId, userId);
  audit(userId, "merchant", merchantId, "update", previous, { name, defaultCategoryId });
  return listMerchants(userId, true).find((merchant) => merchant.id === merchantId);
}

export function setMerchantArchived(userId: string, merchantId: string, archived: boolean) {
  const previous = one<ManagedMerchantRow>(
    "SELECT id, name, default_category_id AS defaultCategoryId, NULL AS defaultCategoryName, archived_at AS archivedAt, 0 AS transactionCount FROM merchants WHERE id = ? AND user_id = ?",
    [merchantId, userId],
  );
  if (!previous) throw new HttpError(404, "Merchant not found");
  const archivedAt = archived ? new Date().toISOString() : null;
  database().prepare("UPDATE merchants SET archived_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
    .run(archivedAt, merchantId, userId);
  audit(userId, "merchant", merchantId, archived ? "archive" : "restore", previous, { archivedAt });
  return listMerchants(userId, true).find((merchant) => merchant.id === merchantId);
}

function normalizeMerchant(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function ensureMerchant(userId: string, name?: string | null): string | null {
  if (!name?.trim()) return null;
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean.length > 120) throw new HttpError(422, "Merchant name must be 120 characters or fewer");
  const normalized = normalizeMerchant(clean);
  const existing = one<{ id: string; archivedAt: string | null }>(
    "SELECT id, archived_at AS archivedAt FROM merchants WHERE user_id = ? AND normalized_name = ?",
    [userId, normalized],
  );
  if (existing?.archivedAt) throw new HttpError(422, "This merchant is archived. Restore it before using it on a new entry");
  if (existing) return existing.id;
  const id = randomUUID();
  database()
    .prepare("INSERT INTO merchants (id, user_id, name, normalized_name) VALUES (?, ?, ?, ?)")
    .run(id, userId, clean, normalized);
  return id;
}

function ensureTag(userId: string, name: string): string {
  const clean = cleanTagName(name);
  const existing = one<{ id: string; archivedAt: string | null }>(
    "SELECT id, archived_at AS archivedAt FROM tags WHERE user_id = ? AND name = ? COLLATE NOCASE",
    [userId, clean],
  );
  if (existing?.archivedAt) throw new HttpError(422, `The tag “${clean}” is archived. Restore it before using it`);
  if (existing) return existing.id;
  const id = randomUUID();
  database().prepare("INSERT INTO tags (id, user_id, name) VALUES (?, ?, ?)").run(id, userId, clean);
  return id;
}

function fingerprint(userId: string, accountId: string, date: string, amountMinor: number, kind: string, merchant: string | null) {
  return createHash("sha256")
    .update([userId, accountId, date, amountMinor, kind, normalizeMerchant(merchant ?? "")].join("|"))
    .digest("hex");
}

function assertOwnedAccount(userId: string, accountId: string) {
  const account = one<{ id: string; currency: string; type: string }>(
    "SELECT id, currency, type FROM accounts WHERE id = ? AND user_id = ? AND archived_at IS NULL",
    [accountId, userId],
  );
  if (!account) throw new HttpError(422, "Choose an active account");
  return account;
}

function assertOwnedCategory(
  userId: string,
  categoryId: string,
  allowArchived = false,
  intendedKind?: "income" | "expense",
) {
  const category = one<{ id: string; kind: CategoryKind }>(
    `SELECT id, kind FROM categories WHERE id = ? AND user_id = ? ${allowArchived ? "" : "AND archived_at IS NULL"}`,
    [categoryId, userId],
  );
  if (!category) throw new HttpError(422, "Choose an active category that belongs to your profile");
  if (intendedKind && category.kind !== "both" && category.kind !== intendedKind) {
    throw new HttpError(422, `Choose an ${intendedKind} category for this transaction`);
  }
  return category;
}

function assertOwnedMerchant(userId: string, merchantId: string, allowArchived = false) {
  const merchant = one<{ id: string }>(
    `SELECT id FROM merchants WHERE id = ? AND user_id = ? ${allowArchived ? "" : "AND archived_at IS NULL"}`,
    [merchantId, userId],
  );
  if (!merchant) throw new HttpError(422, "Choose a merchant that belongs to your profile");
  return merchant.id;
}

function assertOwnedPlannedOccurrence(userId: string, occurrenceId: string) {
  const occurrence = one<{ id: string }>(
    `SELECT o.id FROM planned_payment_occurrences o
       JOIN planned_payments p ON p.id = o.planned_payment_id
      WHERE o.id = ? AND p.user_id = ?`,
    [occurrenceId, userId],
  );
  if (!occurrence) throw new HttpError(422, "Choose a planned-payment occurrence that belongs to your profile");
}

export interface TransactionInput {
  kind: "income" | "expense" | "transfer" | "refund" | "adjustment";
  status?: "pending" | "cleared";
  accountId: string;
  transferAccountId?: string | null;
  amountMinor: number;
  destinationAmountMinor?: number | null;
  originalAmountMinor?: number | null;
  originalCurrency?: string | null;
  fxRateScaled?: number | null;
  fxRateSource?: "bnr" | "manual" | null;
  fxRateDate?: string | null;
  referenceFxRateScaled?: number | null;
  referenceFxRateDate?: string | null;
  date: string;
  categoryId?: string | null;
  merchant?: string | null;
  note?: string | null;
  tags?: string[];
  splits?: Array<{ categoryId: string; amountMinor: number; note?: string | null }>;
  receiptReference?: string | null;
  duplicateConfirmed?: boolean;
  externalId?: string | null;
  plannedOccurrenceId?: string | null;
  adjustmentSign?: -1 | 1;
}

interface TransactionPostingOptions {
  allowLiabilityTransfer?: boolean;
  allowArchivedMetadata?: boolean;
  merchantId?: string | null;
}

function createTransactionInternal(
  userId: string,
  input: TransactionInput,
  options: TransactionPostingOptions,
) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new HttpError(422, "Transaction amount must be a positive integer in minor units");
  }
  const status = input.status ?? "cleared";
  const source = assertOwnedAccount(userId, input.accountId);
  const destination = input.kind === "transfer" && input.transferAccountId
    ? assertOwnedAccount(userId, input.transferAccountId)
    : null;
  if (input.kind === "transfer" && !destination) throw new HttpError(422, "Choose a destination account");
  if (destination?.id === source.id) throw new HttpError(422, "Transfer accounts must be different");
  if (
    input.kind === "transfer"
    && !options.allowLiabilityTransfer
    && [source.type, destination?.type].some((type) => type === "loan" || type === "credit_card")
  ) {
    throw new HttpError(422, "Use the dedicated loan or credit-card workflow for liability transfers");
  }
  if (input.kind === "adjustment" && (source.type === "loan" || source.type === "credit_card")) {
    throw new HttpError(422, "Use the dedicated loan or credit-card workflow to reconcile a liability balance");
  }
  if (source.type === "loan" && input.kind !== "transfer" && input.kind !== "adjustment") {
    throw new HttpError(422, "Use the loan payment workflow so principal, interest, and fees are classified correctly");
  }
  const intendedCategoryKind = input.kind === "refund"
    ? "expense"
    : input.kind === "adjustment"
      ? input.adjustmentSign === -1 ? "expense" : "income"
      : input.kind === "income" || input.kind === "expense" ? input.kind : undefined;
  if (input.kind === "transfer" && input.categoryId) {
    throw new HttpError(422, "Transfers cannot be assigned to income or expense categories");
  }
  if (input.categoryId) {
    assertOwnedCategory(userId, input.categoryId, options.allowArchivedMetadata, intendedCategoryKind);
  }
  if (input.splits?.length) {
    let splitTotal = 0n;
    for (const split of input.splits) {
      if (!Number.isSafeInteger(split.amountMinor) || split.amountMinor === 0) {
        throw new HttpError(422, "Every split amount must be a non-zero integer in minor units");
      }
      assertOwnedCategory(userId, split.categoryId, options.allowArchivedMetadata, intendedCategoryKind);
      splitTotal += BigInt(Math.abs(split.amountMinor));
    }
    if (splitTotal !== BigInt(input.amountMinor)) {
      throw new HttpError(422, "Split amounts must add up to the transaction amount");
    }
  }
  if (input.plannedOccurrenceId) assertOwnedPlannedOccurrence(userId, input.plannedOccurrenceId);
  if (input.date.slice(0, 10) > getUserCalendarContext(userId).today) {
    throw new HttpError(422, "Transactions cannot be dated in the future; use Planned Payments for future cash movements");
  }
  const transferFx = destination
    ? validateTransferFxForPosting(
      source.currency,
      destination.currency,
      Math.abs(input.amountMinor),
      input.date,
      input,
    )
    : null;
  const transactionFx = destination
    ? {}
    : validateTransactionFxForPosting(
      source.currency,
      input.kind,
      Math.abs(input.amountMinor),
      input.date,
      input,
    );

  const sign = input.kind === "expense" || input.kind === "transfer"
    ? -1
    : input.kind === "adjustment"
      ? (input.adjustmentSign ?? 1)
      : 1;
  const signedAmount = Math.abs(input.amountMinor) * sign;
  const duplicateFingerprint = fingerprint(userId, source.id, input.date, signedAmount, input.kind, input.merchant ?? null);
  const duplicate = one<{ id: string }>(
    "SELECT id FROM transactions WHERE user_id = ? AND duplicate_fingerprint = ? AND voided_at IS NULL LIMIT 1",
    [userId, duplicateFingerprint],
  );
  if (duplicate && !input.duplicateConfirmed) {
    throw new HttpError(409, "This looks like a duplicate transaction", { duplicateId: duplicate.id });
  }

  const primaryId = randomUUID();
  const peerId = destination ? randomUUID() : null;
  const transferGroupId = destination ? randomUUID() : null;
  const result = database().transaction(() => {
    const merchantId = options.merchantId === undefined
      ? ensureMerchant(userId, input.merchant)
      : options.merchantId === null
        ? null
        : assertOwnedMerchant(userId, options.merchantId, options.allowArchivedMetadata);
    const defaultCategory = merchantId && !input.categoryId && !input.splits?.length && (input.kind === "expense" || input.kind === "refund")
      ? one<{ id: string }>(
          `SELECT c.id FROM merchants m JOIN categories c ON c.id = m.default_category_id
            WHERE m.id = ? AND m.user_id = ? AND m.archived_at IS NULL
              AND c.user_id = ? AND c.archived_at IS NULL AND c.kind IN ('expense', 'both')`,
          [merchantId, userId, userId],
        )
      : undefined;
    const categoryId = input.categoryId ?? defaultCategory?.id ?? null;
    const insert = database().prepare(
      `INSERT INTO transactions
        (id, user_id, account_id, category_id, merchant_id, kind, status, amount_minor,
         currency, original_amount_minor, original_currency, fx_rate_scaled, fx_rate_source,
         fx_rate_date, reference_fx_rate_scaled, reference_fx_rate_date,
         occurred_at, merchant_text, notes, transfer_group_id, transfer_peer_id,
         planned_occurrence_id, external_id, duplicate_fingerprint, is_split)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      primaryId,
      userId,
      source.id,
      categoryId,
      merchantId,
      input.kind,
      status,
      signedAmount,
      source.currency,
      transactionFx.originalAmountMinor ?? null,
      transactionFx.originalCurrency ?? null,
      transactionFx.fxRateScaled ?? null,
      transactionFx.fxRateSource ?? null,
      transactionFx.fxRateDate ?? null,
      transactionFx.referenceFxRateScaled ?? null,
      transactionFx.referenceFxRateDate ?? null,
      input.date,
      input.merchant?.trim() || null,
      input.note ?? null,
      transferGroupId,
      peerId,
      input.plannedOccurrenceId ?? null,
      input.externalId ?? null,
      duplicateFingerprint,
      Boolean(input.splits?.length) ? 1 : 0,
    );

    if (destination && peerId && transferGroupId && transferFx) {
      const crossCurrency = destination.currency !== source.currency;
      insert.run(
        peerId,
        userId,
        destination.id,
        null,
        merchantId,
        "transfer",
        status,
        transferFx.destinationAmountMinor,
        destination.currency,
        crossCurrency ? Math.abs(input.amountMinor) : null,
        crossCurrency ? source.currency : null,
        crossCurrency ? transferFx.fxRateScaled ?? null : null,
        crossCurrency ? transferFx.fxRateSource ?? null : null,
        crossCurrency ? transferFx.fxRateDate ?? null : null,
        crossCurrency ? transferFx.referenceFxRateScaled ?? null : null,
        crossCurrency ? transferFx.referenceFxRateDate ?? null : null,
        input.date,
        input.merchant?.trim() || null,
        input.note ?? null,
        transferGroupId,
        primaryId,
        null,
        input.externalId ?? null,
        fingerprint(userId, destination.id, input.date, transferFx.destinationAmountMinor, "transfer", input.merchant ?? null),
        0,
      );
    }

    if (input.splits?.length) {
      const splitInsert = database().prepare(
        "INSERT INTO transaction_splits (id, transaction_id, category_id, amount_minor, notes, display_order) VALUES (?, ?, ?, ?, ?, ?)",
      );
      input.splits.forEach((split, index) => {
        splitInsert.run(
          randomUUID(),
          primaryId,
          split.categoryId,
          Math.abs(split.amountMinor) * Math.sign(signedAmount),
          split.note ?? null,
          index,
        );
      });
    }
    if (input.tags?.length) {
      const tagInsert = database().prepare("INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)");
      for (const tagName of input.tags) tagInsert.run(primaryId, ensureTag(userId, tagName));
    }
    if (input.receiptReference) {
      database()
        .prepare("INSERT INTO attachments (id, user_id, transaction_id, file_name, external_reference) VALUES (?, ?, ?, ?, ?)")
        .run(randomUUID(), userId, primaryId, "Receipt reference", input.receiptReference);
    }
    audit(userId, "transaction", primaryId, "create", undefined, input);
    return { id: primaryId, peerId, transferGroupId };
  })();
  return result;
}

export function createTransaction(userId: string, input: TransactionInput) {
  return createTransactionInternal(userId, input, {});
}

export function createLiabilityTransaction(userId: string, input: TransactionInput) {
  return createTransactionInternal(userId, input, {
    allowLiabilityTransfer: true,
    allowArchivedMetadata: true,
  });
}

function createPlannedActualTransaction(
  userId: string,
  input: TransactionInput,
  merchantId: string | null,
) {
  return createTransactionInternal(userId, input, {
    allowArchivedMetadata: true,
    merchantId,
  });
}

export interface TransactionFilters {
  from?: string;
  to?: string;
  accountId?: string;
  categoryId?: string;
  tag?: string;
  status?: string;
  kind?: string;
  merchant?: string;
  search?: string;
  minMinor?: number;
  maxMinor?: number;
  limit?: number;
  offset?: number;
  /** Internal portability path; API callers remain capped by the normal limit. */
  exportAll?: boolean;
}

function transactionFilter(userId: string, filters: TransactionFilters) {
  const hasAmountFilter = filters.minMinor !== undefined || filters.maxMinor !== undefined;
  if (hasAmountFilter && !filters.accountId) {
    throw new HttpError(422, "Choose one account before filtering by amount; native account currencies cannot be compared directly");
  }
  if (hasAmountFilter && !one<{ id: string }>(
    "SELECT id FROM accounts WHERE id = ? AND user_id = ?",
    [filters.accountId as string, userId],
  )) {
    throw new HttpError(422, "Choose an account that belongs to your profile before filtering by amount");
  }
  const where = ["t.user_id = ?"];
  const params: SqlValue[] = [userId];
  const add = (clause: string, value: SqlValue) => {
    where.push(clause);
    params.push(value);
  };
  if (filters.from) add("substr(t.occurred_at, 1, 10) >= ?", filters.from);
  if (filters.to) add("substr(t.occurred_at, 1, 10) <= ?", filters.to);
  if (filters.status === "void") where.push("t.status = 'void'");
  else {
    where.push("t.voided_at IS NULL");
    if (filters.status) add("t.status = ?", filters.status);
  }
  if (filters.accountId) add("t.account_id = ?", filters.accountId);
  if (filters.categoryId) {
    where.push(
      `(t.category_id = ? OR EXISTS (
        SELECT 1 FROM transaction_splits category_split
         WHERE category_split.transaction_id = t.id AND category_split.category_id = ?
      ))`,
    );
    params.push(filters.categoryId, filters.categoryId);
  }
  if (filters.kind) add("t.kind = ?", filters.kind);
  if (filters.merchant) add("LOWER(COALESCE(m.name, t.merchant_text, '')) LIKE LOWER(?)", `%${filters.merchant}%`);
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    where.push(
      `(LOWER(COALESCE(m.name, t.merchant_text, '') || ' ' || COALESCE(t.notes, '') || ' '
              || COALESCE(a.name, '') || ' ' || COALESCE(c.name, '')) LIKE LOWER(?)
        OR EXISTS (
          SELECT 1 FROM transaction_splits search_split
          JOIN categories search_category ON search_category.id = search_split.category_id
          WHERE search_split.transaction_id = t.id AND LOWER(search_category.name) LIKE LOWER(?)
        ))`,
    );
    params.push(pattern, pattern);
  }
  if (filters.minMinor !== undefined) add("ABS(t.amount_minor) >= ?", filters.minMinor);
  if (filters.maxMinor !== undefined) add("ABS(t.amount_minor) <= ?", filters.maxMinor);
  if (filters.tag) add("EXISTS (SELECT 1 FROM transaction_tags xt JOIN tags xg ON xg.id = xt.tag_id WHERE xt.transaction_id = t.id AND xg.name = ?)", filters.tag);
  return { where: where.join(" AND "), params };
}

function transactionPageBounds(filters: TransactionFilters) {
  const limit = filters.exportAll ? -1 : Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const requestedOffset = filters.offset ?? 0;
  const offset = filters.exportAll || !Number.isSafeInteger(requestedOffset) || requestedOffset < 0
    ? 0
    : requestedOffset;
  return { limit, offset };
}

export interface TransactionListRow {
  id: string;
  date: string;
  type: string;
  kind: string;
  status: string;
  amountMinor: number;
  currency: string;
  originalAmountMinor: number | null;
  originalCurrency: string | null;
  fxRateScaled: number | null;
  fxRateSource: "bnr" | "manual" | null;
  fxRateDate: string | null;
  referenceFxRateScaled: number | null;
  referenceFxRateDate: string | null;
  externalId: string | null;
  accountId: string;
  account: string;
  categoryId: string | null;
  category: string | null;
  merchant: string | null;
  note: string | null;
  transferGroupId: string | null;
  transferPeerId: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  toAmountMinor: number | null;
  toCurrency: string | null;
  attachmentRef: string | null;
  attachmentCount: number;
  isSplit: number;
  splitCount: number;
  splits: Array<{ categoryId: string; amountMinor: number; note: string | null }>;
  plannedOccurrenceId: string | null;
  tags: string | null;
}

export function listTransactions(userId: string, filters: TransactionFilters = {}): TransactionListRow[] {
  const filter = transactionFilter(userId, filters);
  const { limit, offset } = transactionPageBounds(filters);
  const params = [...filter.params, limit, offset];

  const rows = all<Omit<TransactionListRow, "splitCount" | "splits">>(
    `SELECT t.id, t.occurred_at AS date, t.kind AS type, t.kind, t.status, t.amount_minor AS amountMinor,
            t.currency, t.original_amount_minor AS originalAmountMinor,
            t.original_currency AS originalCurrency, t.fx_rate_scaled AS fxRateScaled,
            t.fx_rate_source AS fxRateSource, t.fx_rate_date AS fxRateDate,
            t.reference_fx_rate_scaled AS referenceFxRateScaled,
            t.reference_fx_rate_date AS referenceFxRateDate,
            t.external_id AS externalId,
            t.account_id AS accountId, a.name AS account,
            t.category_id AS categoryId, c.name AS category,
            COALESCE(m.name, t.merchant_text) AS merchant, t.notes AS note,
            t.transfer_group_id AS transferGroupId, t.transfer_peer_id AS transferPeerId,
            peer.account_id AS toAccountId, peer_account.name AS toAccountName,
            ABS(peer.amount_minor) AS toAmountMinor, peer.currency AS toCurrency,
            (SELECT external_reference FROM attachments
              WHERE transaction_id = t.id AND external_reference IS NOT NULL
              ORDER BY created_at, id LIMIT 1) AS attachmentRef,
            (SELECT COUNT(*) FROM attachments WHERE transaction_id = t.id) AS attachmentCount,
            t.is_split AS isSplit, t.planned_occurrence_id AS plannedOccurrenceId,
            GROUP_CONCAT(DISTINCT tg.name) AS tags
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN merchants m ON m.id = t.merchant_id
       LEFT JOIN transactions peer ON peer.id = t.transfer_peer_id AND peer.voided_at IS NULL
       LEFT JOIN accounts peer_account ON peer_account.id = peer.account_id
       LEFT JOIN transaction_tags tt ON tt.transaction_id = t.id
       LEFT JOIN tags tg ON tg.id = tt.tag_id
      WHERE ${filter.where}
      GROUP BY t.id
      ORDER BY t.occurred_at DESC, t.created_at DESC
      LIMIT ? OFFSET ?`,
    params,
  );
  const splitQuery = database().prepare(
    `SELECT category_id AS categoryId, ABS(amount_minor) AS amountMinor, notes AS note
       FROM transaction_splits
      WHERE transaction_id = ?
      ORDER BY display_order, id`,
  );
  return rows.map((row) => {
    const splits = row.isSplit
      ? splitQuery.all(row.id) as TransactionListRow["splits"]
      : [];
    return { ...row, splitCount: splits.length, splits };
  });
}

export function listTransactionPage(userId: string, filters: TransactionFilters = {}) {
  const boundedFilters = { ...filters, exportAll: false };
  const filter = transactionFilter(userId, boundedFilters);
  const { limit, offset } = transactionPageBounds(boundedFilters);
  const aggregate = one<{
    total: number;
    clearedCount: number;
  }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN t.status = 'cleared' THEN 1 ELSE 0 END), 0) AS clearedCount
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN merchants m ON m.id = t.merchant_id
      WHERE ${filter.where}`,
    filter.params,
  ) ?? { total: 0, clearedCount: 0 };
  const reportingCurrency = getUserRegionalSettings(userId).currency;
  const summaryRows = all<{
    id: string;
    date: string;
    currency: string;
    kind: "income" | "expense" | "refund";
    amountMinor: number;
  }>(
    `SELECT t.id, substr(t.occurred_at, 1, 10) AS date, t.currency, t.kind,
            t.amount_minor AS amountMinor
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN merchants m ON m.id = t.merchant_id
      WHERE ${filter.where} AND t.status = 'cleared' AND t.kind IN ('income', 'expense', 'refund')
      ORDER BY t.occurred_at, t.id`,
    filter.params,
  );
  let incomeMinor = 0;
  let grossSpendingMinor = 0;
  let refundsMinor = 0;
  const missingFx = new Set<string>();
  for (const row of summaryRows) {
    const currency = normalizeCurrencyCode(row.currency);
    let reportingAmount = row.amountMinor;
    if (currency !== reportingCurrency) {
      const quote = findPersistedBnrQuote(row.date, currency, reportingCurrency);
      if (!quote) {
        missingFx.add(`${row.date}:${currency}/${reportingCurrency}`);
        continue;
      }
      reportingAmount = convertMinorAtRate(
        row.amountMinor,
        quote.rateScaled,
        quote.fromMinorUnitDigits,
        quote.toMinorUnitDigits,
      );
    }
    if (row.kind === "income" && reportingAmount > 0) incomeMinor += reportingAmount;
    if (row.kind === "expense" && reportingAmount < 0) grossSpendingMinor += -reportingAmount;
    if (row.kind === "refund" && reportingAmount > 0) refundsMinor += reportingAmount;
  }
  const monetaryTotalsAvailable = missingFx.size === 0;
  const netSpendingMinor = Math.max(0, grossSpendingMinor - refundsMinor);
  return {
    transactions: listTransactions(userId, { ...boundedFilters, limit, offset }),
    total: aggregate.total,
    limit,
    offset,
    summary: {
      clearedCount: aggregate.clearedCount,
      currency: reportingCurrency,
      monetaryTotalsAvailable,
      incomeMinor: monetaryTotalsAvailable ? incomeMinor : null,
      netSpendingMinor: monetaryTotalsAvailable ? netSpendingMinor : null,
      missingFx: [...missingFx],
    },
  };
}

function voidTransactionInternal(userId: string, transactionId: string, allowWorkflowLinked: boolean) {
  const transaction = one<{
    id: string;
    transferGroupId: string | null;
    plannedOccurrenceId: string | null;
    plannedLink: number;
    liabilityLink: number;
  }>(
    `SELECT t.id, t.transfer_group_id AS transferGroupId,
            t.planned_occurrence_id AS plannedOccurrenceId,
            EXISTS(SELECT 1 FROM planned_payment_transactions ppt WHERE ppt.transaction_id = t.id) AS plannedLink,
            (EXISTS(
              SELECT 1 FROM credit_card_payments cp
               WHERE cp.voided_at IS NULL AND (cp.source_transaction_id = t.id OR cp.card_transaction_id = t.id)
            ) OR EXISTS(
              SELECT 1 FROM loan_payments lp
               WHERE lp.voided_at IS NULL AND (
                 lp.source_principal_transaction_id = t.id OR lp.loan_principal_transaction_id = t.id
                 OR lp.interest_transaction_id = t.id OR lp.fee_transaction_id = t.id
               )
            )) AS liabilityLink
       FROM transactions t
      WHERE t.id = ? AND t.user_id = ? AND t.voided_at IS NULL`,
    [transactionId, userId],
  );
  if (!transaction) throw new HttpError(404, "Transaction not found");
  if (!allowWorkflowLinked && (transaction.plannedOccurrenceId || transaction.plannedLink)) {
    throw new HttpError(409, "Use planned-payment undo so the occurrence and actual transaction stay reconciled");
  }
  if (!allowWorkflowLinked && transaction.liabilityLink) {
    throw new HttpError(409, "Use liability-payment undo so the debt ledger and transaction stay reconciled");
  }
  return database().transaction(() => {
    const now = new Date().toISOString();
    if (transaction.transferGroupId) {
      database().prepare("UPDATE transactions SET status = 'void', voided_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND transfer_group_id = ?")
        .run(now, userId, transaction.transferGroupId);
    } else {
      database().prepare("UPDATE transactions SET status = 'void', voided_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
        .run(now, transactionId, userId);
    }
    audit(userId, "transaction", transactionId, "void", transaction);
    return { success: true };
  })();
}

export function voidTransaction(userId: string, transactionId: string) {
  return voidTransactionInternal(userId, transactionId, false);
}

export function voidWorkflowTransaction(userId: string, transactionId: string) {
  return voidTransactionInternal(userId, transactionId, true);
}

export function clearPendingTransaction(userId: string, transactionId: string) {
  const transaction = one<{ id: string; transferGroupId: string | null; status: string; occurredAt: string }>(
    `SELECT id, transfer_group_id AS transferGroupId, status, occurred_at AS occurredAt
       FROM transactions WHERE id = ? AND user_id = ? AND voided_at IS NULL`,
    [transactionId, userId],
  );
  if (!transaction) throw new HttpError(404, "Transaction not found");
  if (transaction.status !== "pending") throw new HttpError(409, "Only pending transactions can be cleared");
  if (transaction.occurredAt.slice(0, 10) > getUserCalendarContext(userId).today) {
    throw new HttpError(409, "A pending transaction cannot be cleared before its transaction date");
  }
  return database().transaction(() => {
    const rows = transaction.transferGroupId
      ? all<{ id: string }>(
          "SELECT id FROM transactions WHERE user_id = ? AND transfer_group_id = ? AND voided_at IS NULL",
          [userId, transaction.transferGroupId],
        )
      : [{ id: transaction.id }];
    if (transaction.transferGroupId && rows.length !== 2) {
      throw new HttpError(409, "This transfer is incomplete and cannot be cleared safely");
    }
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    database().prepare(
      `UPDATE transactions SET status = 'cleared', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND id IN (${placeholders}) AND voided_at IS NULL`,
    ).run(userId, ...ids);
    audit(userId, "transaction", transaction.id, "clear", transaction, { transactionIds: ids, status: "cleared" });
    return { success: true, status: "cleared" as const, transactionIds: ids };
  })();
}

function dateParts(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return { year, month, day };
}

function utcKey(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function addRecurrence(dateKey: string, frequency: string, interval: number, desiredDay: number) {
  const { year, month, day } = dateParts(dateKey);
  const current = new Date(Date.UTC(year, month - 1, day));
  if (frequency === "daily") current.setUTCDate(current.getUTCDate() + interval);
  if (frequency === "weekly") current.setUTCDate(current.getUTCDate() + 7 * interval);
  if (frequency === "monthly") {
    const targetIndex = year * 12 + (month - 1) + interval;
    const targetYear = Math.floor(targetIndex / 12);
    const targetMonthIndex = targetIndex % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
    return utcKey(targetYear, targetMonthIndex + 1, Math.min(desiredDay, lastDay));
  }
  if (frequency === "yearly") {
    const targetYear = year + interval;
    const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
    return utcKey(targetYear, month, Math.min(desiredDay, lastDay));
  }
  return current.toISOString().slice(0, 10);
}

interface RecurringRow {
  paymentId: string;
  amountMinor: number;
  startDate: string;
  frequency: string;
  interval: number;
  endDate: string | null;
  occurrenceCount: number | null;
  dayOfMonth: number | null;
  latestDueDate: string | null;
  materializedCount: number;
}

// API date ranges are capped at ten years. This covers every daily occurrence
// in one request while still stopping corrupted rules from looping forever.
const MAX_OCCURRENCES_PER_MATERIALIZATION = 4_000;

export function materializePlannedOccurrences(userId: string, throughDate: string) {
  const recurring = all<RecurringRow>(
    `SELECT p.id AS paymentId, p.expected_amount_minor AS amountMinor,
            r.start_date AS startDate, r.frequency, r.interval, r.end_date AS endDate,
            r.occurrence_count AS occurrenceCount, r.day_of_month AS dayOfMonth,
            progress.latest_due_date AS latestDueDate,
            COALESCE(progress.materialized_count, 0) AS materializedCount
       FROM planned_payments p JOIN recurrence_rules r ON r.id = p.recurrence_rule_id
       LEFT JOIN (
         SELECT planned_payment_id, MAX(due_date) AS latest_due_date, COUNT(*) AS materialized_count
           FROM planned_payment_occurrences
          GROUP BY planned_payment_id
       ) progress ON progress.planned_payment_id = p.id
      WHERE p.user_id = ? AND p.active = 1 AND p.archived_at IS NULL`,
    [userId],
  );
  const insert = database().prepare(
    `INSERT OR IGNORE INTO planned_payment_occurrences
      (id, planned_payment_id, due_date, expected_amount_minor, status, generated_from_rule)
     VALUES (?, ?, ?, ?, 'planned', 1)`,
  );
  database().transaction(() => {
    for (const rule of recurring) {
      const desiredDay = rule.dayOfMonth ?? dateParts(rule.startDate).day;
      let cursor = rule.latestDueDate
        ? addRecurrence(rule.latestDueDate, rule.frequency, rule.interval, desiredDay)
        : rule.startDate;
      let count = rule.materializedCount;
      let generatedThisRun = 0;
      while (
        cursor <= throughDate
        && (!rule.endDate || cursor <= rule.endDate)
        && (rule.occurrenceCount === null || count < rule.occurrenceCount)
        && generatedThisRun < MAX_OCCURRENCES_PER_MATERIALIZATION
      ) {
        insert.run(randomUUID(), rule.paymentId, cursor, rule.amountMinor);
        const next = addRecurrence(cursor, rule.frequency, rule.interval, desiredDay);
        if (next <= cursor) throw new HttpError(422, "Recurring payment rules must advance to a later date");
        cursor = next;
        count += 1;
        generatedThisRun += 1;
      }
    }
    database()
      .prepare(
        `UPDATE planned_payment_occurrences
            SET status = 'overdue', updated_at = CURRENT_TIMESTAMP
          WHERE status IN ('planned', 'scheduled') AND due_date < ?
            AND planned_payment_id IN (SELECT id FROM planned_payments WHERE user_id = ?)`,
      )
      .run(getUserCalendarContext(userId).today, userId);
  })();
}

interface PlannedInput {
  name: string;
  expectedAmountMinor: number;
  currency?: string;
  dueDate: string;
  type?: "income" | "expense";
  categoryId?: string | null;
  accountId?: string | null;
  merchant?: string | null;
  note?: string | null;
  status?: string;
  recurrence?: { frequency: string; interval?: number; endDate?: string | null } | null;
}

export function createPlannedPayment(userId: string, input: PlannedInput) {
  if (input.status && !["planned", "scheduled"].includes(input.status)) {
    throw new HttpError(422, "New planned payments must start as planned or scheduled");
  }
  const account = input.accountId ? assertOwnedAccount(userId, input.accountId) : undefined;
  if (input.categoryId) assertOwnedCategory(userId, input.categoryId, false, input.type ?? "expense");
  const regionalSettings = getUserRegionalSettings(userId);
  const currency = normalizeCurrencyCode(input.currency ?? account?.currency ?? regionalSettings.currency);
  if (!isSupportedCurrency(currency)) throw new HttpError(422, "Choose a supported ISO 4217 planned-payment currency");
  const paymentId = randomUUID();
  const occurrenceId = randomUUID();
  const result = database().transaction(() => {
    const merchantId = ensureMerchant(userId, input.merchant);
    let recurrenceRuleId: string | null = null;
    if (input.recurrence) {
      recurrenceRuleId = randomUUID();
      const quarterly = input.recurrence.frequency === "quarterly";
      const frequency = quarterly ? "monthly" : input.recurrence.frequency;
      const interval = (input.recurrence.interval ?? 1) * (quarterly ? 3 : 1);
      database()
        .prepare(
          `INSERT INTO recurrence_rules
            (id, user_id, frequency, interval, start_date, end_date, day_of_month, time_zone)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          recurrenceRuleId,
          userId,
          frequency,
          interval,
          input.dueDate,
          input.recurrence.endDate ?? null,
          dateParts(input.dueDate).day,
          regionalSettings.timeZone,
        );
    }
    database()
      .prepare(
        `INSERT INTO planned_payments
          (id, user_id, title, direction, expected_amount_minor, currency, due_date, account_id,
           category_id, merchant_id, recurrence_rule_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        paymentId,
        userId,
        input.name,
        input.type ?? "expense",
        input.expectedAmountMinor,
        currency,
        input.dueDate,
        input.accountId ?? null,
        input.categoryId ?? null,
        merchantId,
        recurrenceRuleId,
        input.note ?? null,
      );
    database()
      .prepare(
        `INSERT INTO planned_payment_occurrences
          (id, planned_payment_id, due_date, expected_amount_minor, status, generated_from_rule)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(occurrenceId, paymentId, input.dueDate, input.expectedAmountMinor, input.status ?? "planned", recurrenceRuleId ? 1 : 0);
    audit(userId, "planned_payment", paymentId, "create", undefined, { ...input, currency });
    return { id: occurrenceId, plannedPaymentId: paymentId, currency };
  })();
  return result;
}

export interface PlannedFilters {
  from?: string;
  to?: string;
  status?: string;
  includeArchived?: boolean;
}

export interface PlannedListRow {
  id: string;
  plannedPaymentId: string;
  name: string;
  title: string;
  type: "income" | "expense";
  direction: "income" | "expense";
  expectedAmountMinor: number;
  currency: string;
  paidAmountMinor: number;
  dueDate: string;
  status: string;
  accountId: string | null;
  account: string | null;
  categoryId: string | null;
  category: string | null;
  merchant: string | null;
  note: string | null;
  recurrenceRuleId: string | null;
  frequency: string | null;
  interval: number | null;
  recurrenceEndDate: string | null;
  archivedAt: string | null;
  spendingNature: string | null;
  spendingPriority: string | null;
}

export function listPlannedPayments(userId: string, filters: PlannedFilters = {}): PlannedListRow[] {
  const today = getUserCalendarContext(userId).today;
  const todayParts = dateParts(today);
  const through = filters.to ?? utcKey(todayParts.year + 1, todayParts.month, todayParts.day);
  materializePlannedOccurrences(userId, through);
  const where = ["p.user_id = ?"];
  const params: SqlValue[] = [userId];
  if (!filters.includeArchived) where.push("p.archived_at IS NULL", "p.active = 1");
  if (filters.from) {
    where.push("o.due_date >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    where.push("o.due_date <= ?");
    params.push(filters.to);
  }
  if (filters.status) {
    where.push("o.status = ?");
    params.push(filters.status);
  }
  return all<PlannedListRow>(
    `SELECT o.id, p.id AS plannedPaymentId, p.title AS name, p.title,
            p.direction AS type, p.direction, o.expected_amount_minor AS expectedAmountMinor,
            p.currency,
            o.paid_amount_minor AS paidAmountMinor, o.due_date AS dueDate, o.status,
            p.account_id AS accountId, a.name AS account, p.category_id AS categoryId,
            c.name AS category, m.name AS merchant, COALESCE(o.notes, p.notes) AS note,
            p.recurrence_rule_id AS recurrenceRuleId, r.frequency, r.interval,
            r.end_date AS recurrenceEndDate, p.archived_at AS archivedAt,
            COALESCE(p.spending_nature, c.spending_nature) AS spendingNature,
            COALESCE(p.spending_priority, c.spending_priority) AS spendingPriority
       FROM planned_payment_occurrences o
       JOIN planned_payments p ON p.id = o.planned_payment_id
       LEFT JOIN accounts a ON a.id = p.account_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN merchants m ON m.id = p.merchant_id
       LEFT JOIN recurrence_rules r ON r.id = p.recurrence_rule_id
      WHERE ${where.join(" AND ")}
      ORDER BY o.due_date, p.title`,
    params,
  );
}

export interface PlannedOccurrencePaymentInput extends TransactionFxFields {
  /** Absolute amount posted to the selected account, in that account's currency. */
  amountMinor: number;
  /** Amount satisfied on the occurrence, in the planned payment's currency. */
  appliedAmountMinor?: number;
  date: string;
  accountId: string;
  partial?: boolean;
  note?: string | null;
}

function plannedOccurrencePaymentCurrencies(userId: string, occurrenceId: string, accountId: string) {
  const occurrence = one<{ currency: string; direction: "income" | "expense" }>(
    `SELECT p.currency, p.direction
       FROM planned_payment_occurrences o
       JOIN planned_payments p ON p.id = o.planned_payment_id
      WHERE o.id = ? AND p.user_id = ?`,
    [occurrenceId, userId],
  );
  if (!occurrence) throw new HttpError(404, "Planned payment not found");
  const account = assertOwnedAccount(userId, accountId);
  const plannedCurrency = normalizeCurrencyCode(occurrence.currency);
  if (!isSupportedCurrency(plannedCurrency)) {
    throw new HttpError(422, "The planned payment has an unsupported currency");
  }
  return {
    plannedCurrency,
    accountCurrency: normalizeCurrencyCode(account.currency),
    direction: occurrence.direction,
  };
}

/**
 * Resolves and snapshots the plan-currency to account-currency conversion
 * before the synchronous occurrence/payment transaction begins.
 */
export async function preparePlannedOccurrencePayment(
  userId: string,
  occurrenceId: string,
  input: PlannedOccurrencePaymentInput,
): Promise<PlannedOccurrencePaymentInput & { appliedAmountMinor: number }> {
  const context = plannedOccurrencePaymentCurrencies(userId, occurrenceId, input.accountId);
  if (context.plannedCurrency !== context.accountCurrency && input.appliedAmountMinor == null) {
    throw new HttpError(422, `Enter the amount applied in ${context.plannedCurrency} as well as the account amount in ${context.accountCurrency}`);
  }
  const appliedAmountMinor = input.appliedAmountMinor ?? input.amountMinor;
  if (!Number.isSafeInteger(appliedAmountMinor) || appliedAmountMinor <= 0) {
    throw new HttpError(422, "Applied planned amount must be a positive integer in minor units");
  }
  const preparedFx = await prepareTransactionFx(
    userId,
    input.accountId,
    context.direction,
    input.amountMinor,
    input.date,
    {
      originalAmountMinor: appliedAmountMinor,
      originalCurrency: context.plannedCurrency,
      fxRateScaled: input.fxRateScaled,
      fxRateSource: input.fxRateSource,
      fxRateDate: input.fxRateDate,
      referenceFxRateScaled: input.referenceFxRateScaled,
      referenceFxRateDate: input.referenceFxRateDate,
    },
  );
  return { ...input, appliedAmountMinor, ...preparedFx };
}

export function payPlannedOccurrence(
  userId: string,
  occurrenceId: string,
  input: PlannedOccurrencePaymentInput,
) {
  const occurrence = one<{
    id: string;
    paymentId: string;
    title: string;
    direction: "income" | "expense";
    expectedAmountMinor: number;
    paidAmountMinor: number;
    currency: string;
    status: string;
    categoryId: string | null;
    merchant: string | null;
    merchantId: string | null;
    active: number;
    archivedAt: string | null;
  }>(
    `SELECT o.id, p.id AS paymentId, p.title, p.direction, p.currency,
            o.expected_amount_minor AS expectedAmountMinor, o.paid_amount_minor AS paidAmountMinor,
            o.status, p.category_id AS categoryId, p.merchant_id AS merchantId, m.name AS merchant,
            p.active, p.archived_at AS archivedAt
       FROM planned_payment_occurrences o
       JOIN planned_payments p ON p.id = o.planned_payment_id
       LEFT JOIN merchants m ON m.id = p.merchant_id
      WHERE o.id = ? AND p.user_id = ?`,
    [occurrenceId, userId],
  );
  if (!occurrence) throw new HttpError(404, "Planned payment not found");
  if (!occurrence.active || occurrence.archivedAt) {
    throw new HttpError(409, "Restore this planned payment before recording an actual payment");
  }
  if (occurrence.status === "paid") throw new HttpError(409, "This planned payment is already paid. Undo it before recording a replacement");
  if (["skipped", "cancelled"].includes(occurrence.status)) {
    throw new HttpError(409, `A ${occurrence.status} payment cannot be paid until it is restored`);
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new HttpError(422, "Account amount must be a positive integer in minor units");
  }
  const account = assertOwnedAccount(userId, input.accountId);
  const accountCurrency = normalizeCurrencyCode(account.currency);
  const plannedCurrency = normalizeCurrencyCode(occurrence.currency);
  if (!isSupportedCurrency(plannedCurrency)) {
    throw new HttpError(422, "The planned payment has an unsupported currency");
  }
  const appliedAmountMinor = input.appliedAmountMinor ?? input.amountMinor;
  if (!Number.isSafeInteger(appliedAmountMinor) || appliedAmountMinor <= 0) {
    throw new HttpError(422, "Applied planned amount must be a positive integer in minor units");
  }
  if (accountCurrency !== plannedCurrency && input.appliedAmountMinor == null) {
    throw new HttpError(422, `Enter the amount applied in ${plannedCurrency} as well as the account amount in ${accountCurrency}`);
  }
  if (input.originalAmountMinor != null && input.originalAmountMinor !== appliedAmountMinor) {
    throw new HttpError(422, "The prepared original amount does not match the amount applied to the planned payment");
  }
  if (input.originalCurrency && normalizeCurrencyCode(input.originalCurrency) !== plannedCurrency) {
    throw new HttpError(422, "The prepared original currency does not match the planned payment currency");
  }

  return database().transaction(() => {
    const transaction = createPlannedActualTransaction(userId, {
      kind: occurrence.direction,
      accountId: input.accountId,
      amountMinor: input.amountMinor,
      originalAmountMinor: appliedAmountMinor,
      originalCurrency: plannedCurrency,
      fxRateScaled: input.fxRateScaled,
      fxRateSource: input.fxRateSource,
      fxRateDate: input.fxRateDate,
      referenceFxRateScaled: input.referenceFxRateScaled,
      referenceFxRateDate: input.referenceFxRateDate,
      date: input.date,
      categoryId: occurrence.categoryId,
      merchant: occurrence.merchant,
      note: input.note ?? `Paid from plan: ${occurrence.title}`,
      duplicateConfirmed: true,
      plannedOccurrenceId: occurrence.id,
    }, occurrence.merchantId);
    database()
      .prepare(
        "INSERT INTO planned_payment_transactions (occurrence_id, transaction_id, applied_amount_minor) VALUES (?, ?, ?)",
      )
      .run(occurrence.id, transaction.id, appliedAmountMinor);
    const cumulativeValue = BigInt(occurrence.paidAmountMinor) + BigInt(appliedAmountMinor);
    if (cumulativeValue > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new HttpError(422, "Cumulative planned payments exceed the safe integer range");
    }
    const cumulative = Number(cumulativeValue);
    const status = cumulative < occurrence.expectedAmountMinor ? "scheduled" : "paid";
    database()
      .prepare(
        `UPDATE planned_payment_occurrences
            SET paid_amount_minor = ?, status_before_payment = COALESCE(status_before_payment, status),
                status = ?, paid_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      )
      .run(cumulative, status, input.date, occurrence.id);
    audit(userId, "planned_occurrence", occurrence.id, input.partial || status !== "paid" ? "partial_pay" : "pay", occurrence, {
      transactionId: transaction.id,
      accountAmountMinor: input.amountMinor,
      accountCurrency,
      appliedAmountMinor,
      plannedCurrency,
      status,
    });
    return {
      transactionId: transaction.id,
      occurrenceId: occurrence.id,
      status,
      paidAmountMinor: cumulative,
      accountAmountMinor: input.amountMinor,
      accountCurrency,
      appliedAmountMinor,
      plannedCurrency,
    };
  })();
}

export function skipPlannedOccurrence(userId: string, occurrenceId: string, reason?: string | null) {
  const occurrence = one<Record<string, unknown> & { paidAmountMinor: number; linkedPayments: number }>(
    `SELECT o.*, o.paid_amount_minor AS paidAmountMinor,
            (SELECT COUNT(*) FROM planned_payment_transactions link WHERE link.occurrence_id = o.id) AS linkedPayments
       FROM planned_payment_occurrences o JOIN planned_payments p ON p.id = o.planned_payment_id
      WHERE o.id = ? AND p.user_id = ?`,
    [occurrenceId, userId],
  );
  if (!occurrence) throw new HttpError(404, "Planned payment not found");
  if (occurrence.paidAmountMinor > 0 || occurrence.linkedPayments > 0) {
    throw new HttpError(409, "Undo recorded payments before skipping this occurrence");
  }
  database()
    .prepare("UPDATE planned_payment_occurrences SET status = 'skipped', skipped_at = ?, notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(new Date().toISOString(), reason ?? null, occurrenceId);
  audit(userId, "planned_occurrence", occurrenceId, "skip", occurrence, { reason });
  return { success: true, status: "skipped" };
}

export function cancelPlannedOccurrence(userId: string, occurrenceId: string, reason?: string | null) {
  const occurrence = one<Record<string, unknown> & { paidAmountMinor: number; linkedPayments: number; status: string }>(
    `SELECT o.*, o.paid_amount_minor AS paidAmountMinor, o.status,
            (SELECT COUNT(*) FROM planned_payment_transactions link WHERE link.occurrence_id = o.id) AS linkedPayments
       FROM planned_payment_occurrences o JOIN planned_payments p ON p.id = o.planned_payment_id
      WHERE o.id = ? AND p.user_id = ?`,
    [occurrenceId, userId],
  );
  if (!occurrence) throw new HttpError(404, "Planned payment not found");
  if (occurrence.paidAmountMinor > 0 || occurrence.linkedPayments > 0 || occurrence.status === "paid") {
    throw new HttpError(409, "Undo recorded payments before cancelling this occurrence");
  }
  if (occurrence.status === "cancelled") throw new HttpError(409, "This occurrence is already cancelled");
  if (occurrence.status === "skipped") throw new HttpError(409, "Undo the skipped occurrence before cancelling it");
  database().prepare(
    `UPDATE planned_payment_occurrences
        SET status = 'cancelled', cancelled_at = ?, notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  ).run(new Date().toISOString(), reason ?? null, occurrenceId);
  audit(userId, "planned_occurrence", occurrenceId, "cancel", occurrence, { reason });
  return { success: true, status: "cancelled" };
}

export function undoPlannedOccurrence(userId: string, occurrenceId: string) {
  const occurrence = one<{ statusBeforePayment: string | null; status: string }>(
    `SELECT o.status_before_payment AS statusBeforePayment, o.status
       FROM planned_payment_occurrences o JOIN planned_payments p ON p.id = o.planned_payment_id
      WHERE o.id = ? AND p.user_id = ?`,
    [occurrenceId, userId],
  );
  if (!occurrence) throw new HttpError(404, "Planned payment not found");
  return database().transaction(() => {
    const links = all<{ transactionId: string }>(
      "SELECT transaction_id AS transactionId FROM planned_payment_transactions WHERE occurrence_id = ?",
      [occurrenceId],
    );
    const now = new Date().toISOString();
    for (const link of links) {
      database()
        .prepare("UPDATE transactions SET status = 'void', voided_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
        .run(now, link.transactionId, userId);
    }
    database().prepare("DELETE FROM planned_payment_transactions WHERE occurrence_id = ?").run(occurrenceId);
    const restoredStatus = occurrence.statusBeforePayment ?? (occurrence.status === "skipped" ? "planned" : "planned");
    database()
      .prepare(
        `UPDATE planned_payment_occurrences
            SET paid_amount_minor = 0, paid_at = NULL, skipped_at = NULL, cancelled_at = NULL,
                status = ?, status_before_payment = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      )
      .run(restoredStatus, occurrenceId);
    audit(userId, "planned_occurrence", occurrenceId, "undo", occurrence, { restoredStatus, voidedTransactions: links.length });
    return { success: true, status: restoredStatus, voidedTransactions: links.length };
  })();
}

export function archivePlannedPayment(userId: string, plannedPaymentId: string, archived: boolean) {
  const result = database()
    .prepare("UPDATE planned_payments SET archived_at = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
    .run(archived ? new Date().toISOString() : null, archived ? 0 : 1, plannedPaymentId, userId);
  if (!result.changes) throw new HttpError(404, "Planned payment not found");
  audit(userId, "planned_payment", plannedPaymentId, archived ? "archive" : "restore");
  return { success: true };
}
