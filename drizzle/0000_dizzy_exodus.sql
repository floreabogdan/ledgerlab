CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`custom_type` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`opening_balance_minor` integer DEFAULT 0 NOT NULL,
	`opening_balance_date` text NOT NULL,
	`credit_limit_minor` integer,
	`institution` text,
	`color` text,
	`icon` text,
	`display_order` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_user_order_idx` ON `accounts` (`user_id`,`display_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_user_name_unique` ON `accounts` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`transaction_id` text,
	`planned_payment_id` text,
	`file_name` text NOT NULL,
	`storage_path` text,
	`external_reference` text,
	`mime_type` text,
	`size_bytes` integer,
	`sha256` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`planned_payment_id`) REFERENCES `planned_payments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "attachments_owner_check" CHECK("attachments"."transaction_id" IS NOT NULL OR "attachments"."planned_payment_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `attachments_transaction_idx` ON `attachments` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before` text,
	`after` text,
	`metadata` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `balance_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`balance_minor` integer NOT NULL,
	`source` text DEFAULT 'calculated' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_snapshots_account_date_unique` ON `balance_snapshots` (`account_id`,`snapshot_date`);--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`month` text NOT NULL,
	`category_id` text,
	`amount_minor` integer NOT NULL,
	`rollover` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "budgets_amount_nonnegative" CHECK("budgets"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_user_month_category_unique` ON `budgets` (`user_id`,`month`,`category_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`kind` text DEFAULT 'expense' NOT NULL,
	`spending_nature` text,
	`spending_priority` text,
	`color` text,
	`icon` text,
	`display_order` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `categories_user_parent_idx` ON `categories` (`user_id`,`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_parent_name_unique` ON `categories` (`user_id`,`parent_id`,`name`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text,
	`file_name` text NOT NULL,
	`status` text DEFAULT 'preview' NOT NULL,
	`column_mapping` text NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`imported_rows` integer DEFAULT 0 NOT NULL,
	`duplicate_rows` integer DEFAULT 0 NOT NULL,
	`invalid_rows` integer DEFAULT 0 NOT NULL,
	`errors` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `import_batches_user_created_idx` ON `import_batches` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `import_records` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`row_number` integer NOT NULL,
	`raw_data` text NOT NULL,
	`status` text NOT NULL,
	`duplicate_of_transaction_id` text,
	`transaction_id` text,
	`validation_errors` text,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`duplicate_of_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_records_batch_row_unique` ON `import_records` (`batch_id`,`row_number`);--> statement-breakpoint
CREATE TABLE `merchants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`default_category_id` text,
	`notes` text,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_user_normalized_name_unique` ON `merchants` (`user_id`,`normalized_name`);--> statement-breakpoint
CREATE TABLE `month_plan_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`month_plan_id` text NOT NULL,
	`account_id` text NOT NULL,
	`expected_opening_minor` integer NOT NULL,
	`expected_closing_minor` integer,
	FOREIGN KEY (`month_plan_id`) REFERENCES `month_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `month_plan_accounts_plan_account_unique` ON `month_plan_accounts` (`month_plan_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `month_plan_items` (
	`id` text PRIMARY KEY NOT NULL,
	`month_plan_id` text NOT NULL,
	`planned_payment_id` text,
	`occurrence_id` text,
	`account_id` text,
	`category_id` text,
	`title` text NOT NULL,
	`direction` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`expected_date` text NOT NULL,
	`spending_nature` text,
	`spending_priority` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`month_plan_id`) REFERENCES `month_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`planned_payment_id`) REFERENCES `planned_payments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`occurrence_id`) REFERENCES `planned_payment_occurrences`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `month_plan_items_plan_date_idx` ON `month_plan_items` (`month_plan_id`,`expected_date`);--> statement-breakpoint
CREATE TABLE `month_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`month` text NOT NULL,
	`name` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`expected_income_minor` integer DEFAULT 0 NOT NULL,
	`discretionary_target_minor` integer,
	`copied_from_plan_id` text,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`copied_from_plan_id`) REFERENCES `month_plans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `month_plans_user_month_unique` ON `month_plans` (`user_id`,`month`);--> statement-breakpoint
CREATE TABLE `plan_scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`month_plan_id` text NOT NULL,
	`name` text NOT NULL,
	`is_baseline` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`month_plan_id`) REFERENCES `month_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_scenarios_plan_name_unique` ON `plan_scenarios` (`month_plan_id`,`name`);--> statement-breakpoint
CREATE TABLE `planned_payment_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`planned_payment_id` text NOT NULL,
	`due_date` text NOT NULL,
	`expected_amount_minor` integer NOT NULL,
	`paid_amount_minor` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`status_before_payment` text,
	`scheduled_at` text,
	`paid_at` text,
	`skipped_at` text,
	`cancelled_at` text,
	`generated_from_rule` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`planned_payment_id`) REFERENCES `planned_payments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "planned_occurrences_amount_nonnegative" CHECK("planned_payment_occurrences"."expected_amount_minor" >= 0 AND "planned_payment_occurrences"."paid_amount_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planned_occurrences_payment_due_unique` ON `planned_payment_occurrences` (`planned_payment_id`,`due_date`);--> statement-breakpoint
CREATE INDEX `planned_occurrences_status_due_idx` ON `planned_payment_occurrences` (`status`,`due_date`);--> statement-breakpoint
CREATE TABLE `planned_payment_transactions` (
	`occurrence_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`applied_amount_minor` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`occurrence_id`, `transaction_id`),
	FOREIGN KEY (`occurrence_id`) REFERENCES `planned_payment_occurrences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planned_payment_transaction_unique` ON `planned_payment_transactions` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `planned_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`direction` text DEFAULT 'expense' NOT NULL,
	`expected_amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`due_date` text NOT NULL,
	`account_id` text,
	`category_id` text,
	`merchant_id` text,
	`recurrence_rule_id` text,
	`notes` text,
	`spending_nature` text,
	`spending_priority` text,
	`active` integer DEFAULT true NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recurrence_rule_id`) REFERENCES `recurrence_rules`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "planned_payments_amount_nonnegative" CHECK("planned_payments"."expected_amount_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX `planned_payments_user_due_idx` ON `planned_payments` (`user_id`,`due_date`);--> statement-breakpoint
CREATE TABLE `recurrence_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`frequency` text NOT NULL,
	`interval` integer DEFAULT 1 NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`occurrence_count` integer,
	`days_of_week` text,
	`day_of_month` integer,
	`month_of_year` integer,
	`adjustment` text DEFAULT 'clamp' NOT NULL,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "recurrence_interval_positive" CHECK("recurrence_rules"."interval" > 0),
	CONSTRAINT "recurrence_day_of_month_valid" CHECK("recurrence_rules"."day_of_month" IS NULL OR ("recurrence_rules"."day_of_month" BETWEEN 1 AND 31))
);
--> statement-breakpoint
CREATE TABLE `scenario_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`month_plan_item_id` text,
	`account_id` text,
	`title` text,
	`amount_delta_minor` integer DEFAULT 0 NOT NULL,
	`replacement_date` text,
	`excluded` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`scenario_id`) REFERENCES `plan_scenarios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`month_plan_item_id`) REFERENCES `month_plan_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scenario_adjustments_scenario_idx` ON `scenario_adjustments` (`scenario_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`user_agent` text,
	`ip_address` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_expires_idx` ON `sessions` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_user_name_unique` ON `tags` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `transaction_splits` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`category_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`notes` text,
	`display_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `transaction_splits_transaction_idx` ON `transaction_splits` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `transaction_tags` (
	`transaction_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`transaction_id`, `tag_id`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `transaction_tags_tag_idx` ON `transaction_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`category_id` text,
	`merchant_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'cleared' NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`occurred_at` text NOT NULL,
	`booked_at` text,
	`merchant_text` text,
	`notes` text,
	`transfer_group_id` text,
	`transfer_peer_id` text,
	`planned_occurrence_id` text,
	`external_id` text,
	`duplicate_fingerprint` text,
	`is_split` integer DEFAULT false NOT NULL,
	`voided_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "transactions_transfer_group_check" CHECK("transactions"."kind" <> 'transfer' OR "transactions"."transfer_group_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `transactions_user_date_idx` ON `transactions` (`user_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `transactions_account_date_idx` ON `transactions` (`account_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `transactions_category_date_idx` ON `transactions` (`category_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `transactions_transfer_group_idx` ON `transactions` (`transfer_group_id`);--> statement-breakpoint
CREATE INDEX `transactions_fingerprint_idx` ON `transactions` (`user_id`,`duplicate_fingerprint`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`normalized_email` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`default_currency` text DEFAULT 'USD' NOT NULL,
	`locale` text DEFAULT 'en-US' NOT NULL,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`demo_data_enabled` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_normalized_email_unique` ON `users` (`normalized_email`);
