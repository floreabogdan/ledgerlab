CREATE TABLE `credit_card_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`source_account_id` text NOT NULL,
	`statement_id` text,
	`payment_date` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`transfer_group_id` text NOT NULL,
	`source_transaction_id` text NOT NULL,
	`card_transaction_id` text NOT NULL,
	`voided_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`statement_id`) REFERENCES `credit_card_statements`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`card_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "credit_card_payment_amount_positive" CHECK("credit_card_payments"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE INDEX `credit_card_payments_account_date_idx` ON `credit_card_payments` (`account_id`,`payment_date`);--> statement-breakpoint
CREATE TABLE `credit_card_profiles` (
	`account_id` text PRIMARY KEY NOT NULL,
	`statement_day` integer,
	`due_day` integer,
	`grace_period_days` integer,
	`purchase_apr_bps` integer,
	`minimum_payment_mode` text DEFAULT 'manual' NOT NULL,
	`minimum_payment_rate_bps` integer,
	`minimum_payment_fixed_minor` integer,
	`payment_preference` text DEFAULT 'full_statement' NOT NULL,
	`generate_planned_payments` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "credit_card_profile_days_valid" CHECK(
    ("credit_card_profiles"."statement_day" IS NULL OR "credit_card_profiles"."statement_day" BETWEEN 1 AND 31)
    AND ("credit_card_profiles"."due_day" IS NULL OR "credit_card_profiles"."due_day" BETWEEN 1 AND 31)
    AND ("credit_card_profiles"."grace_period_days" IS NULL OR "credit_card_profiles"."grace_period_days" >= 0))
);
--> statement-breakpoint
CREATE TABLE `credit_card_statements` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`closing_date` text NOT NULL,
	`due_date` text NOT NULL,
	`statement_balance_minor` integer NOT NULL,
	`minimum_due_minor` integer DEFAULT 0 NOT NULL,
	`payments_applied_minor` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "credit_card_statement_amounts_valid" CHECK(
    "credit_card_statements"."statement_balance_minor" >= 0 AND "credit_card_statements"."minimum_due_minor" >= 0
    AND "credit_card_statements"."payments_applied_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_card_statements_account_closing_unique` ON `credit_card_statements` (`account_id`,`closing_date`);--> statement-breakpoint
CREATE INDEX `credit_card_statements_due_idx` ON `credit_card_statements` (`account_id`,`due_date`);--> statement-breakpoint
CREATE TABLE `loan_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`loan_account_id` text NOT NULL,
	`source_account_id` text NOT NULL,
	`schedule_entry_id` text,
	`payment_date` text NOT NULL,
	`total_minor` integer NOT NULL,
	`principal_minor` integer NOT NULL,
	`interest_minor` integer NOT NULL,
	`fees_minor` integer DEFAULT 0 NOT NULL,
	`principal_transfer_group_id` text,
	`source_principal_transaction_id` text,
	`loan_principal_transaction_id` text,
	`interest_transaction_id` text,
	`fee_transaction_id` text,
	`notes` text,
	`voided_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`loan_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`schedule_entry_id`) REFERENCES `loan_schedule_entries`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_principal_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`loan_principal_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`interest_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`fee_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "loan_payment_allocation_valid" CHECK(
    "loan_payments"."total_minor" > 0 AND "loan_payments"."principal_minor" >= 0
    AND "loan_payments"."interest_minor" >= 0 AND "loan_payments"."fees_minor" >= 0
    AND "loan_payments"."total_minor" = "loan_payments"."principal_minor" + "loan_payments"."interest_minor" + "loan_payments"."fees_minor")
);
--> statement-breakpoint
CREATE INDEX `loan_payments_account_date_idx` ON `loan_payments` (`loan_account_id`,`payment_date`);--> statement-breakpoint
CREATE TABLE `loan_profiles` (
	`account_id` text PRIMARY KEY NOT NULL,
	`original_principal_minor` integer NOT NULL,
	`origination_date` text NOT NULL,
	`first_payment_date` text NOT NULL,
	`maturity_date` text,
	`payment_account_id` text,
	`payment_frequency` text DEFAULT 'monthly' NOT NULL,
	`payment_interval_months` integer DEFAULT 1 NOT NULL,
	`term_months` integer NOT NULL,
	`amortization_method` text DEFAULT 'annuity' NOT NULL,
	`regular_payment_minor` integer,
	`balloon_minor` integer DEFAULT 0 NOT NULL,
	`day_count_convention` text DEFAULT 'actual_365' NOT NULL,
	`jurisdiction_code` text,
	`interest_category_id` text,
	`fee_category_id` text,
	`generate_planned_payments` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payment_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`interest_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`fee_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "loan_profile_values_valid" CHECK(
    "loan_profiles"."original_principal_minor" > 0 AND "loan_profiles"."term_months" > 0
    AND "loan_profiles"."payment_interval_months" > 0 AND "loan_profiles"."balloon_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE `loan_rate_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`loan_account_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`rate_type` text NOT NULL,
	`fixed_rate_bps` integer,
	`reference_index` text,
	`reference_tenor_months` integer,
	`reference_rate_bps` integer,
	`margin_bps` integer DEFAULT 0 NOT NULL,
	`reset_frequency_months` integer,
	`next_reset_date` text,
	`observation_lag_months` integer DEFAULT 0 NOT NULL,
	`floor_rate_bps` integer,
	`cap_rate_bps` integer,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`loan_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "loan_rate_period_type_values" CHECK(
    ("loan_rate_periods"."rate_type" = 'fixed' AND "loan_rate_periods"."fixed_rate_bps" IS NOT NULL)
    OR ("loan_rate_periods"."rate_type" = 'variable' AND "loan_rate_periods"."reference_rate_bps" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loan_rate_periods_account_effective_unique` ON `loan_rate_periods` (`loan_account_id`,`effective_from`);--> statement-breakpoint
CREATE INDEX `loan_rate_periods_effective_idx` ON `loan_rate_periods` (`loan_account_id`,`effective_from`,`effective_to`);--> statement-breakpoint
CREATE TABLE `loan_schedule_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`loan_account_id` text NOT NULL,
	`installment_number` integer NOT NULL,
	`due_date` text NOT NULL,
	`opening_principal_minor` integer NOT NULL,
	`payment_minor` integer NOT NULL,
	`principal_minor` integer NOT NULL,
	`interest_minor` integer NOT NULL,
	`fees_minor` integer DEFAULT 0 NOT NULL,
	`closing_principal_minor` integer NOT NULL,
	`annual_rate_bps` integer NOT NULL,
	`status` text DEFAULT 'projected' NOT NULL,
	`paid_principal_minor` integer DEFAULT 0 NOT NULL,
	`paid_interest_minor` integer DEFAULT 0 NOT NULL,
	`paid_fees_minor` integer DEFAULT 0 NOT NULL,
	`is_estimate` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`loan_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "loan_schedule_amounts_valid" CHECK(
    "loan_schedule_entries"."opening_principal_minor" >= 0 AND "loan_schedule_entries"."payment_minor" >= 0
    AND "loan_schedule_entries"."principal_minor" >= 0 AND "loan_schedule_entries"."interest_minor" >= 0
    AND "loan_schedule_entries"."fees_minor" >= 0 AND "loan_schedule_entries"."closing_principal_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loan_schedule_entries_account_due_unique` ON `loan_schedule_entries` (`loan_account_id`,`due_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `loan_schedule_entries_account_number_unique` ON `loan_schedule_entries` (`loan_account_id`,`installment_number`);--> statement-breakpoint
CREATE INDEX `loan_schedule_entries_due_idx` ON `loan_schedule_entries` (`due_date`,`status`);