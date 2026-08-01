import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { DEFAULT_CURRENCY, DEFAULT_LOCALE, DEFAULT_TIME_ZONE } from "@/lib/currencies";

export type AccountType =
  | "current"
  | "savings"
  | "cash"
  | "credit_card"
  | "loan"
  | "investment"
  | "custom";
export type TransactionKind = "income" | "expense" | "transfer" | "refund" | "adjustment";
export type TransactionStatus = "pending" | "cleared" | "void";
export type PlannedStatus = "planned" | "scheduled" | "overdue" | "paid" | "skipped" | "cancelled";
export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";
export type CategoryKind = "income" | "expense" | "both";
export type SpendingNature = "fixed" | "variable";
export type SpendingPriority = "essential" | "discretionary";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    defaultCurrency: text("default_currency").notNull().default(DEFAULT_CURRENCY),
    locale: text("locale").notNull().default(DEFAULT_LOCALE),
    timeZone: text("time_zone").notNull().default(DEFAULT_TIME_ZONE),
    demoDataEnabled: integer("demo_data_enabled", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_normalized_email_unique").on(table.normalizedEmail)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_expires_idx").on(table.userId, table.expiresAt),
  ],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull().$type<AccountType>(),
    customType: text("custom_type"),
    currency: text("currency").notNull().default(DEFAULT_CURRENCY),
    openingBalanceMinor: integer("opening_balance_minor").notNull().default(0),
    openingBalanceDate: text("opening_balance_date").notNull(),
    creditLimitMinor: integer("credit_limit_minor"),
    institution: text("institution"),
    color: text("color"),
    icon: text("icon"),
    displayOrder: integer("display_order").notNull().default(0),
    archivedAt: text("archived_at"),
    ...timestamps,
  },
  (table) => [
    index("accounts_user_order_idx").on(table.userId, table.displayOrder),
    uniqueIndex("accounts_user_name_unique").on(table.userId, table.name),
  ],
);

export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    snapshotDate: text("snapshot_date").notNull(),
    balanceMinor: integer("balance_minor").notNull(),
    source: text("source").notNull().default("calculated").$type<"calculated" | "manual" | "imported">(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("balance_snapshots_account_date_unique").on(table.accountId, table.snapshotDate),
  ],
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => categories.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("expense").$type<CategoryKind>(),
    spendingNature: text("spending_nature").$type<SpendingNature>(),
    spendingPriority: text("spending_priority").$type<SpendingPriority>(),
    color: text("color"),
    icon: text("icon"),
    displayOrder: integer("display_order").notNull().default(0),
    archivedAt: text("archived_at"),
    ...timestamps,
  },
  (table) => [
    index("categories_user_parent_idx").on(table.userId, table.parentId),
    uniqueIndex("categories_user_parent_name_unique").on(table.userId, table.parentId, table.name),
  ],
);

export const merchants = sqliteTable(
  "merchants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    defaultCategoryId: text("default_category_id").references(() => categories.id, { onDelete: "set null" }),
    notes: text("notes"),
    archivedAt: text("archived_at"),
    ...timestamps,
  },
  (table) => [uniqueIndex("merchants_user_normalized_name_unique").on(table.userId, table.normalizedName)],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    archivedAt: text("archived_at"),
    ...timestamps,
  },
  (table) => [uniqueIndex("tags_user_name_unique").on(table.userId, table.name)],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
    merchantId: text("merchant_id").references(() => merchants.id, { onDelete: "set null" }),
    kind: text("kind").notNull().$type<TransactionKind>(),
    status: text("status").notNull().default("cleared").$type<TransactionStatus>(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull().default(DEFAULT_CURRENCY),
    originalAmountMinor: integer("original_amount_minor"),
    originalCurrency: text("original_currency"),
    fxRateScaled: integer("fx_rate_scaled"),
    fxRateSource: text("fx_rate_source").$type<"bnr" | "manual">(),
    fxRateDate: text("fx_rate_date"),
    referenceFxRateScaled: integer("reference_fx_rate_scaled"),
    referenceFxRateDate: text("reference_fx_rate_date"),
    occurredAt: text("occurred_at").notNull(),
    bookedAt: text("booked_at"),
    merchantText: text("merchant_text"),
    notes: text("notes"),
    transferGroupId: text("transfer_group_id"),
    transferPeerId: text("transfer_peer_id"),
    plannedOccurrenceId: text("planned_occurrence_id"),
    externalId: text("external_id"),
    duplicateFingerprint: text("duplicate_fingerprint"),
    isSplit: integer("is_split", { mode: "boolean" }).notNull().default(false),
    voidedAt: text("voided_at"),
    ...timestamps,
  },
  (table) => [
    index("transactions_user_date_idx").on(table.userId, table.occurredAt),
    index("transactions_account_date_idx").on(table.accountId, table.occurredAt),
    index("transactions_category_date_idx").on(table.categoryId, table.occurredAt),
    index("transactions_transfer_group_idx").on(table.transferGroupId),
    index("transactions_fingerprint_idx").on(table.userId, table.duplicateFingerprint),
    check("transactions_transfer_group_check", sql`${table.kind} <> 'transfer' OR ${table.transferGroupId} IS NOT NULL`),
  ],
);

/**
 * Official BNR observations are global reference data. `publishedRateScaled`
 * stores the XML value at 1e8 precision; `multiplier` retains the XML unit
 * (for example, a JPY quote may be published per 100 JPY).
 */
export const fxRateObservations = sqliteTable(
  "fx_rate_observations",
  {
    id: text("id").primaryKey(),
    rateDate: text("rate_date").notNull(),
    currency: text("currency").notNull(),
    publishedRateScaled: integer("published_rate_scaled").notNull(),
    multiplier: integer("multiplier").notNull().default(1),
    sourceUrl: text("source_url").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => [
    uniqueIndex("fx_rate_observations_date_currency_unique").on(table.rateDate, table.currency),
    index("fx_rate_observations_currency_date_idx").on(table.currency, table.rateDate),
    check("fx_rate_observations_values_positive", sql`${table.publishedRateScaled} > 0 AND ${table.multiplier} > 0`),
  ],
);

export const fxSyncMetadata = sqliteTable("fx_sync_metadata", {
  year: integer("year").primaryKey(),
  sourceUrl: text("source_url").notNull(),
  publishingDate: text("publishing_date"),
  firstObservationDate: text("first_observation_date"),
  lastObservationDate: text("last_observation_date"),
  observationCount: integer("observation_count").notNull().default(0),
  fetchedAt: text("fetched_at").notNull(),
});

export const transactionSplits = sqliteTable(
  "transaction_splits",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    amountMinor: integer("amount_minor").notNull(),
    notes: text("notes"),
    displayOrder: integer("display_order").notNull().default(0),
  },
  (table) => [index("transaction_splits_transaction_idx").on(table.transactionId)],
);

export const transactionTags = sqliteTable(
  "transaction_tags",
  {
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.transactionId, table.tagId] }),
    index("transaction_tags_tag_idx").on(table.tagId),
  ],
);

export const recurrenceRules = sqliteTable(
  "recurrence_rules",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    frequency: text("frequency").notNull().$type<RecurrenceFrequency>(),
    interval: integer("interval").notNull().default(1),
    startDate: text("start_date").notNull(),
    endDate: text("end_date"),
    occurrenceCount: integer("occurrence_count"),
    daysOfWeek: text("days_of_week", { mode: "json" }).$type<number[]>(),
    dayOfMonth: integer("day_of_month"),
    monthOfYear: integer("month_of_year"),
    adjustment: text("adjustment").notNull().default("clamp").$type<"clamp" | "skip">(),
    timeZone: text("time_zone").notNull().default(DEFAULT_TIME_ZONE),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("recurrence_interval_positive", sql`${table.interval} > 0`),
    check("recurrence_day_of_month_valid", sql`${table.dayOfMonth} IS NULL OR (${table.dayOfMonth} BETWEEN 1 AND 31)`),
  ],
);

export const plannedPayments = sqliteTable(
  "planned_payments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    direction: text("direction").notNull().default("expense").$type<"income" | "expense">(),
    expectedAmountMinor: integer("expected_amount_minor").notNull(),
    currency: text("currency").notNull().default(DEFAULT_CURRENCY),
    dueDate: text("due_date").notNull(),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
    merchantId: text("merchant_id").references(() => merchants.id, { onDelete: "set null" }),
    recurrenceRuleId: text("recurrence_rule_id").references(() => recurrenceRules.id, { onDelete: "set null" }),
    notes: text("notes"),
    spendingNature: text("spending_nature").$type<SpendingNature>(),
    spendingPriority: text("spending_priority").$type<SpendingPriority>(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    archivedAt: text("archived_at"),
    ...timestamps,
  },
  (table) => [
    index("planned_payments_user_due_idx").on(table.userId, table.dueDate),
    check("planned_payments_amount_nonnegative", sql`${table.expectedAmountMinor} >= 0`),
  ],
);

export const plannedPaymentOccurrences = sqliteTable(
  "planned_payment_occurrences",
  {
    id: text("id").primaryKey(),
    plannedPaymentId: text("planned_payment_id")
      .notNull()
      .references(() => plannedPayments.id, { onDelete: "cascade" }),
    dueDate: text("due_date").notNull(),
    expectedAmountMinor: integer("expected_amount_minor").notNull(),
    paidAmountMinor: integer("paid_amount_minor").notNull().default(0),
    status: text("status").notNull().default("planned").$type<PlannedStatus>(),
    statusBeforePayment: text("status_before_payment").$type<PlannedStatus>(),
    scheduledAt: text("scheduled_at"),
    paidAt: text("paid_at"),
    skippedAt: text("skipped_at"),
    cancelledAt: text("cancelled_at"),
    generatedFromRule: integer("generated_from_rule", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("planned_occurrences_payment_due_unique").on(table.plannedPaymentId, table.dueDate),
    index("planned_occurrences_status_due_idx").on(table.status, table.dueDate),
    check("planned_occurrences_amount_nonnegative", sql`${table.expectedAmountMinor} >= 0 AND ${table.paidAmountMinor} >= 0`),
  ],
);

export const plannedPaymentTransactions = sqliteTable(
  "planned_payment_transactions",
  {
    occurrenceId: text("occurrence_id")
      .notNull()
      .references(() => plannedPaymentOccurrences.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    appliedAmountMinor: integer("applied_amount_minor").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.occurrenceId, table.transactionId] }),
    uniqueIndex("planned_payment_transaction_unique").on(table.transactionId),
  ],
);

export const creditCardProfiles = sqliteTable("credit_card_profiles", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  statementDay: integer("statement_day"),
  dueDay: integer("due_day"),
  gracePeriodDays: integer("grace_period_days"),
  purchaseAprBps: integer("purchase_apr_bps"),
  minimumPaymentMode: text("minimum_payment_mode")
    .notNull()
    .default("manual")
    .$type<"manual" | "percentage" | "fixed">(),
  minimumPaymentRateBps: integer("minimum_payment_rate_bps"),
  minimumPaymentFixedMinor: integer("minimum_payment_fixed_minor"),
  paymentPreference: text("payment_preference")
    .notNull()
    .default("full_statement")
    .$type<"full_statement" | "minimum" | "custom">(),
  generatePlannedPayments: integer("generate_planned_payments", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
}, (table) => [
  check("credit_card_profile_days_valid", sql`
    (${table.statementDay} IS NULL OR ${table.statementDay} BETWEEN 1 AND 31)
    AND (${table.dueDay} IS NULL OR ${table.dueDay} BETWEEN 1 AND 31)
    AND (${table.gracePeriodDays} IS NULL OR ${table.gracePeriodDays} >= 0)`),
]);

export const creditCardStatements = sqliteTable("credit_card_statements", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  closingDate: text("closing_date").notNull(),
  dueDate: text("due_date").notNull(),
  statementBalanceMinor: integer("statement_balance_minor").notNull(),
  minimumDueMinor: integer("minimum_due_minor").notNull().default(0),
  paymentsAppliedMinor: integer("payments_applied_minor").notNull().default(0),
  status: text("status").notNull().default("open").$type<"open" | "due" | "paid" | "overdue" | "waived">(),
  source: text("source").notNull().default("manual").$type<"manual" | "imported">(),
  notes: text("notes"),
  ...timestamps,
}, (table) => [
  uniqueIndex("credit_card_statements_account_closing_unique").on(table.accountId, table.closingDate),
  index("credit_card_statements_due_idx").on(table.accountId, table.dueDate),
  check("credit_card_statement_amounts_valid", sql`
    ${table.statementBalanceMinor} >= 0 AND ${table.minimumDueMinor} >= 0
    AND ${table.paymentsAppliedMinor} >= 0`),
]);

export const creditCardPayments = sqliteTable("credit_card_payments", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  sourceAccountId: text("source_account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  statementId: text("statement_id").references(() => creditCardStatements.id, { onDelete: "set null" }),
  paymentDate: text("payment_date").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  transferGroupId: text("transfer_group_id").notNull(),
  sourceTransactionId: text("source_transaction_id").notNull().references(() => transactions.id, { onDelete: "restrict" }),
  cardTransactionId: text("card_transaction_id").notNull().references(() => transactions.id, { onDelete: "restrict" }),
  voidedAt: text("voided_at"),
  ...timestamps,
}, (table) => [
  index("credit_card_payments_account_date_idx").on(table.accountId, table.paymentDate),
  check("credit_card_payment_amount_positive", sql`${table.amountMinor} > 0`),
]);

export const loanProfiles = sqliteTable("loan_profiles", {
  accountId: text("account_id").primaryKey().references(() => accounts.id, { onDelete: "cascade" }),
  originalPrincipalMinor: integer("original_principal_minor").notNull(),
  originationDate: text("origination_date").notNull(),
  firstPaymentDate: text("first_payment_date").notNull(),
  maturityDate: text("maturity_date"),
  paymentAccountId: text("payment_account_id").references(() => accounts.id, { onDelete: "set null" }),
  paymentFrequency: text("payment_frequency").notNull().default("monthly").$type<"monthly" | "quarterly" | "yearly" | "custom">(),
  paymentIntervalMonths: integer("payment_interval_months").notNull().default(1),
  termMonths: integer("term_months").notNull(),
  amortizationMethod: text("amortization_method").notNull().default("annuity").$type<"annuity" | "equal_principal" | "interest_only" | "balloon" | "custom">(),
  regularPaymentMinor: integer("regular_payment_minor"),
  balloonMinor: integer("balloon_minor").notNull().default(0),
  dayCountConvention: text("day_count_convention").notNull().default("actual_365").$type<"actual_365" | "actual_360" | "30_360">(),
  jurisdictionCode: text("jurisdiction_code"),
  interestCategoryId: text("interest_category_id").references(() => categories.id, { onDelete: "set null" }),
  feeCategoryId: text("fee_category_id").references(() => categories.id, { onDelete: "set null" }),
  generatePlannedPayments: integer("generate_planned_payments", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
}, (table) => [
  check("loan_profile_values_valid", sql`
    ${table.originalPrincipalMinor} > 0 AND ${table.termMonths} > 0
    AND ${table.paymentIntervalMonths} > 0 AND ${table.balloonMinor} >= 0`),
]);

export const loanRatePeriods = sqliteTable("loan_rate_periods", {
  id: text("id").primaryKey(),
  loanAccountId: text("loan_account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  effectiveFrom: text("effective_from").notNull(),
  effectiveTo: text("effective_to"),
  rateType: text("rate_type").notNull().$type<"fixed" | "variable">(),
  fixedRateBps: integer("fixed_rate_bps"),
  referenceIndex: text("reference_index"),
  referenceTenorMonths: integer("reference_tenor_months"),
  referenceRateBps: integer("reference_rate_bps"),
  marginBps: integer("margin_bps").notNull().default(0),
  resetFrequencyMonths: integer("reset_frequency_months"),
  nextResetDate: text("next_reset_date"),
  observationLagMonths: integer("observation_lag_months").notNull().default(0),
  floorRateBps: integer("floor_rate_bps"),
  capRateBps: integer("cap_rate_bps"),
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("loan_rate_periods_account_effective_unique").on(table.loanAccountId, table.effectiveFrom),
  index("loan_rate_periods_effective_idx").on(table.loanAccountId, table.effectiveFrom, table.effectiveTo),
  check("loan_rate_period_type_values", sql`
    (${table.rateType} = 'fixed' AND ${table.fixedRateBps} IS NOT NULL)
    OR (${table.rateType} = 'variable' AND ${table.referenceRateBps} IS NOT NULL)`),
]);

export const loanScheduleEntries = sqliteTable("loan_schedule_entries", {
  id: text("id").primaryKey(),
  loanAccountId: text("loan_account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  installmentNumber: integer("installment_number").notNull(),
  dueDate: text("due_date").notNull(),
  openingPrincipalMinor: integer("opening_principal_minor").notNull(),
  paymentMinor: integer("payment_minor").notNull(),
  principalMinor: integer("principal_minor").notNull(),
  interestMinor: integer("interest_minor").notNull(),
  feesMinor: integer("fees_minor").notNull().default(0),
  closingPrincipalMinor: integer("closing_principal_minor").notNull(),
  annualRateBps: integer("annual_rate_bps").notNull(),
  status: text("status").notNull().default("projected").$type<"projected" | "scheduled" | "partial" | "paid" | "skipped">(),
  paidPrincipalMinor: integer("paid_principal_minor").notNull().default(0),
  paidInterestMinor: integer("paid_interest_minor").notNull().default(0),
  paidFeesMinor: integer("paid_fees_minor").notNull().default(0),
  isEstimate: integer("is_estimate", { mode: "boolean" }).notNull().default(false),
  ...timestamps,
}, (table) => [
  uniqueIndex("loan_schedule_entries_account_due_unique").on(table.loanAccountId, table.dueDate),
  uniqueIndex("loan_schedule_entries_account_number_unique").on(table.loanAccountId, table.installmentNumber),
  index("loan_schedule_entries_due_idx").on(table.dueDate, table.status),
  check("loan_schedule_amounts_valid", sql`
    ${table.openingPrincipalMinor} >= 0 AND ${table.paymentMinor} >= 0
    AND ${table.principalMinor} >= 0 AND ${table.interestMinor} >= 0
    AND ${table.feesMinor} >= 0 AND ${table.closingPrincipalMinor} >= 0`),
]);

export const loanPayments = sqliteTable("loan_payments", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  loanAccountId: text("loan_account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  sourceAccountId: text("source_account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  scheduleEntryId: text("schedule_entry_id").references(() => loanScheduleEntries.id, { onDelete: "set null" }),
  paymentDate: text("payment_date").notNull(),
  totalMinor: integer("total_minor").notNull(),
  principalMinor: integer("principal_minor").notNull(),
  interestMinor: integer("interest_minor").notNull(),
  feesMinor: integer("fees_minor").notNull().default(0),
  principalTransferGroupId: text("principal_transfer_group_id"),
  sourcePrincipalTransactionId: text("source_principal_transaction_id").references(() => transactions.id, { onDelete: "restrict" }),
  loanPrincipalTransactionId: text("loan_principal_transaction_id").references(() => transactions.id, { onDelete: "restrict" }),
  interestTransactionId: text("interest_transaction_id").references(() => transactions.id, { onDelete: "restrict" }),
  feeTransactionId: text("fee_transaction_id").references(() => transactions.id, { onDelete: "restrict" }),
  notes: text("notes"),
  voidedAt: text("voided_at"),
  ...timestamps,
}, (table) => [
  index("loan_payments_account_date_idx").on(table.loanAccountId, table.paymentDate),
  check("loan_payment_allocation_valid", sql`
    ${table.totalMinor} > 0 AND ${table.principalMinor} >= 0
    AND ${table.interestMinor} >= 0 AND ${table.feesMinor} >= 0
    AND ${table.totalMinor} = ${table.principalMinor} + ${table.interestMinor} + ${table.feesMinor}`),
]);

export const budgets = sqliteTable(
  "budgets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    currency: text("currency").notNull().default("USD"),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "cascade" }),
    amountMinor: integer("amount_minor").notNull(),
    rollover: integer("rollover", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("budgets_user_month_category_unique").on(table.userId, table.month, table.categoryId),
    check("budgets_amount_nonnegative", sql`${table.amountMinor} >= 0`),
  ],
);

export const monthPlans = sqliteTable(
  "month_plans",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    currency: text("currency").notNull().default("USD"),
    name: text("name"),
    status: text("status").notNull().default("draft").$type<"draft" | "active" | "closed">(),
    expectedIncomeMinor: integer("expected_income_minor").notNull().default(0),
    discretionaryTargetMinor: integer("discretionary_target_minor"),
    copiedFromPlanId: text("copied_from_plan_id").references((): AnySQLiteColumn => monthPlans.id, { onDelete: "set null" }),
    notes: text("notes"),
    ...timestamps,
  },
  (table) => [uniqueIndex("month_plans_user_month_unique").on(table.userId, table.month)],
);

export const monthPlanAccounts = sqliteTable(
  "month_plan_accounts",
  {
    id: text("id").primaryKey(),
    monthPlanId: text("month_plan_id")
      .notNull()
      .references(() => monthPlans.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    expectedOpeningMinor: integer("expected_opening_minor").notNull(),
    expectedClosingMinor: integer("expected_closing_minor"),
  },
  (table) => [uniqueIndex("month_plan_accounts_plan_account_unique").on(table.monthPlanId, table.accountId)],
);

export const monthPlanItems = sqliteTable(
  "month_plan_items",
  {
    id: text("id").primaryKey(),
    monthPlanId: text("month_plan_id")
      .notNull()
      .references(() => monthPlans.id, { onDelete: "cascade" }),
    plannedPaymentId: text("planned_payment_id").references(() => plannedPayments.id, { onDelete: "set null" }),
    occurrenceId: text("occurrence_id").references(() => plannedPaymentOccurrences.id, { onDelete: "set null" }),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    direction: text("direction").notNull().$type<"income" | "expense">(),
    amountMinor: integer("amount_minor").notNull(),
    expectedDate: text("expected_date").notNull(),
    spendingNature: text("spending_nature").$type<SpendingNature>(),
    spendingPriority: text("spending_priority").$type<SpendingPriority>(),
    source: text("source").notNull().default("manual").$type<"manual" | "recurring" | "copied">(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("month_plan_items_plan_date_idx").on(table.monthPlanId, table.expectedDate)],
);

export const planScenarios = sqliteTable(
  "plan_scenarios",
  {
    id: text("id").primaryKey(),
    monthPlanId: text("month_plan_id")
      .notNull()
      .references(() => monthPlans.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isBaseline: integer("is_baseline", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    ...timestamps,
  },
  (table) => [uniqueIndex("plan_scenarios_plan_name_unique").on(table.monthPlanId, table.name)],
);

export const scenarioAdjustments = sqliteTable(
  "scenario_adjustments",
  {
    id: text("id").primaryKey(),
    scenarioId: text("scenario_id")
      .notNull()
      .references(() => planScenarios.id, { onDelete: "cascade" }),
    monthPlanItemId: text("month_plan_item_id").references(() => monthPlanItems.id, { onDelete: "cascade" }),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    title: text("title"),
    amountDeltaMinor: integer("amount_delta_minor").notNull().default(0),
    replacementDate: text("replacement_date"),
    excluded: integer("excluded", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("scenario_adjustments_scenario_idx").on(table.scenarioId)],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").references(() => transactions.id, { onDelete: "cascade" }),
    plannedPaymentId: text("planned_payment_id").references(() => plannedPayments.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    storagePath: text("storage_path"),
    externalReference: text("external_reference"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("attachments_transaction_idx").on(table.transactionId),
    check("attachments_owner_check", sql`${table.transactionId} IS NOT NULL OR ${table.plannedPaymentId} IS NOT NULL`),
  ],
);

export const importBatches = sqliteTable(
  "import_batches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    fileName: text("file_name").notNull(),
    status: text("status").notNull().default("preview").$type<"preview" | "imported" | "failed" | "cancelled">(),
    columnMapping: text("column_mapping", { mode: "json" }).notNull().$type<Record<string, string>>(),
    totalRows: integer("total_rows").notNull().default(0),
    importedRows: integer("imported_rows").notNull().default(0),
    duplicateRows: integer("duplicate_rows").notNull().default(0),
    invalidRows: integer("invalid_rows").notNull().default(0),
    errors: text("errors", { mode: "json" }).$type<Array<{ row: number; message: string }>>(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [index("import_batches_user_created_idx").on(table.userId, table.createdAt)],
);

export const importRecords = sqliteTable(
  "import_records",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    rawData: text("raw_data", { mode: "json" }).notNull().$type<Record<string, string>>(),
    status: text("status").notNull().$type<"valid" | "invalid" | "duplicate" | "imported" | "skipped">(),
    duplicateOfTransactionId: text("duplicate_of_transaction_id").references(() => transactions.id, { onDelete: "set null" }),
    transactionId: text("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
    validationErrors: text("validation_errors", { mode: "json" }).$type<string[]>(),
  },
  (table) => [uniqueIndex("import_records_batch_row_unique").on(table.batchId, table.rowNumber)],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    before: text("before", { mode: "json" }).$type<Record<string, unknown>>(),
    after: text("after", { mode: "json" }).$type<Record<string, unknown>>(),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("audit_logs_entity_idx").on(table.entityType, table.entityId, table.createdAt)],
);

export const schema = {
  users,
  sessions,
  accounts,
  balanceSnapshots,
  categories,
  merchants,
  tags,
  transactions,
  fxRateObservations,
  fxSyncMetadata,
  transactionSplits,
  transactionTags,
  recurrenceRules,
  plannedPayments,
  plannedPaymentOccurrences,
  plannedPaymentTransactions,
  creditCardProfiles,
  creditCardStatements,
  creditCardPayments,
  loanProfiles,
  loanRatePeriods,
  loanScheduleEntries,
  loanPayments,
  budgets,
  monthPlans,
  monthPlanAccounts,
  monthPlanItems,
  planScenarios,
  scenarioAdjustments,
  attachments,
  importBatches,
  importRecords,
  auditLogs,
};

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type PlannedPayment = typeof plannedPayments.$inferSelect;
export type PlannedPaymentOccurrence = typeof plannedPaymentOccurrences.$inferSelect;
