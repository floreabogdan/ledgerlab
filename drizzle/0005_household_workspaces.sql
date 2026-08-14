PRAGMA foreign_keys = OFF;
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`default_currency` text DEFAULT 'USD' NOT NULL,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`created_by_user_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `workspaces_type_check` CHECK(`type` IN ('personal', 'household')),
	CONSTRAINT `workspaces_name_nonempty` CHECK(length(trim(`name`)) > 0)
);
--> statement-breakpoint
CREATE INDEX `workspaces_created_by_idx` ON `workspaces` (`created_by_user_id`);
--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workspace_members_role_check` CHECK(`role` IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`,`workspace_id`);
--> statement-breakpoint
CREATE TABLE `workspace_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`normalized_email` text NOT NULL,
	`token_hash` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`revoked_at` text,
	`created_by_user_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `workspace_invitations_role_check` CHECK(`role` IN ('owner', 'member')),
	CONSTRAINT `workspace_invitations_resolution_check` CHECK(`accepted_at` IS NULL OR `revoked_at` IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invitations_token_hash_unique` ON `workspace_invitations` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `workspace_invitations_workspace_email_idx` ON `workspace_invitations` (`workspace_id`,`normalized_email`);
--> statement-breakpoint
CREATE INDEX `workspace_invitations_expiry_idx` ON `workspace_invitations` (`expires_at`);
--> statement-breakpoint
INSERT INTO `workspaces`
	(`id`, `type`, `name`, `default_currency`, `time_zone`, `created_by_user_id`, `created_at`, `updated_at`)
SELECT `id`, 'personal', trim(`display_name`) || '''s workspace', `default_currency`, `time_zone`, `id`, `created_at`, `updated_at`
FROM `users`;
--> statement-breakpoint
INSERT INTO `workspace_members` (`workspace_id`, `user_id`, `role`, `created_at`)
SELECT `id`, `id`, 'owner', `created_at` FROM `users`;
--> statement-breakpoint
ALTER TABLE `users` ADD `is_installation_admin` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `users`
SET `is_installation_admin` = 1
WHERE `id` = (SELECT `id` FROM `users` ORDER BY `created_at`, `id` LIMIT 1);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_installation_admin_unique` ON `users` (`is_installation_admin`) WHERE `is_installation_admin` = 1;
--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`active_workspace_id` text,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`user_agent` text,
	`ip_address` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_sessions` SELECT `id`,`user_id`,`user_id`,`token_hash`,`expires_at`,`last_seen_at`,`user_agent`,`ip_address`,`created_at` FROM `sessions`;
--> statement-breakpoint
DROP TABLE `sessions`;
--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `sessions_user_expires_idx` ON `sessions` (`user_id`,`expires_at`);
--> statement-breakpoint
CREATE TABLE `__new_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
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
	`holder_label` text,
	`display_order` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_accounts` (`id`,`workspace_id`,`name`,`type`,`custom_type`,`currency`,`opening_balance_minor`,`opening_balance_date`,`credit_limit_minor`,`institution`,`color`,`icon`,`holder_label`,`display_order`,`archived_at`,`created_at`,`updated_at`)
SELECT `id`,`user_id`,`name`,`type`,`custom_type`,`currency`,`opening_balance_minor`,`opening_balance_date`,`credit_limit_minor`,`institution`,`color`,`icon`,NULL,`display_order`,`archived_at`,`created_at`,`updated_at` FROM `accounts`;
--> statement-breakpoint
DROP TABLE `accounts`;
--> statement-breakpoint
ALTER TABLE `__new_accounts` RENAME TO `accounts`;
--> statement-breakpoint
CREATE INDEX `accounts_workspace_order_idx` ON `accounts` (`workspace_id`,`display_order`);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_workspace_name_unique` ON `accounts` (`workspace_id`,`name`);
--> statement-breakpoint
CREATE TABLE `__new_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
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
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_categories` SELECT `id`,`user_id`,`parent_id`,`name`,`kind`,`spending_nature`,`spending_priority`,`color`,`icon`,`display_order`,`archived_at`,`created_at`,`updated_at` FROM `categories`;
--> statement-breakpoint
DROP TABLE `categories`;
--> statement-breakpoint
ALTER TABLE `__new_categories` RENAME TO `categories`;
--> statement-breakpoint
CREATE INDEX `categories_workspace_parent_idx` ON `categories` (`workspace_id`,`parent_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_workspace_parent_name_unique` ON `categories` (`workspace_id`,`parent_id`,`name`);
--> statement-breakpoint
CREATE TABLE `__new_merchants` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`default_category_id` text,
	`notes` text,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_merchants` SELECT `id`,`user_id`,`name`,`normalized_name`,`default_category_id`,`notes`,`archived_at`,`created_at`,`updated_at` FROM `merchants`;
--> statement-breakpoint
DROP TABLE `merchants`;
--> statement-breakpoint
ALTER TABLE `__new_merchants` RENAME TO `merchants`;
--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_workspace_normalized_name_unique` ON `merchants` (`workspace_id`,`normalized_name`);
--> statement-breakpoint
CREATE TABLE `__new_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_tags` SELECT `id`,`user_id`,`name`,`color`,`archived_at`,`created_at`,`updated_at` FROM `tags`;
--> statement-breakpoint
DROP TABLE `tags`;
--> statement-breakpoint
ALTER TABLE `__new_tags` RENAME TO `tags`;
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_workspace_name_unique` ON `tags` (`workspace_id`,`name`);
--> statement-breakpoint
CREATE TABLE `__new_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`category_id` text,
	`merchant_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'cleared' NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`original_amount_minor` integer,
	`original_currency` text,
	`fx_rate_scaled` integer,
	`fx_rate_source` text,
	`fx_rate_date` text,
	`reference_fx_rate_scaled` integer,
	`reference_fx_rate_date` text,
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
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `transactions_transfer_group_check` CHECK(`kind` <> 'transfer' OR `transfer_group_id` IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_transactions`
SELECT `id`,`user_id`,`account_id`,`category_id`,`merchant_id`,`kind`,`status`,`amount_minor`,`currency`,`original_amount_minor`,`original_currency`,`fx_rate_scaled`,`fx_rate_source`,`fx_rate_date`,`reference_fx_rate_scaled`,`reference_fx_rate_date`,`occurred_at`,`booked_at`,`merchant_text`,`notes`,`transfer_group_id`,`transfer_peer_id`,`planned_occurrence_id`,`external_id`,`duplicate_fingerprint`,`is_split`,`voided_at`,`created_at`,`updated_at` FROM `transactions`;
--> statement-breakpoint
DROP TABLE `transactions`;
--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;
--> statement-breakpoint
CREATE INDEX `transactions_workspace_date_idx` ON `transactions` (`workspace_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `transactions_account_date_idx` ON `transactions` (`account_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `transactions_category_date_idx` ON `transactions` (`category_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `transactions_transfer_group_idx` ON `transactions` (`transfer_group_id`);
--> statement-breakpoint
CREATE INDEX `transactions_fingerprint_idx` ON `transactions` (`workspace_id`,`duplicate_fingerprint`);
--> statement-breakpoint
CREATE TABLE `__new_recurrence_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
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
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `recurrence_interval_positive` CHECK(`interval` > 0),
	CONSTRAINT `recurrence_day_of_month_valid` CHECK(`day_of_month` IS NULL OR (`day_of_month` BETWEEN 1 AND 31))
);
--> statement-breakpoint
INSERT INTO `__new_recurrence_rules` SELECT `id`,`user_id`,`frequency`,`interval`,`start_date`,`end_date`,`occurrence_count`,`days_of_week`,`day_of_month`,`month_of_year`,`adjustment`,`time_zone`,`created_at` FROM `recurrence_rules`;
--> statement-breakpoint
DROP TABLE `recurrence_rules`;
--> statement-breakpoint
ALTER TABLE `__new_recurrence_rules` RENAME TO `recurrence_rules`;
--> statement-breakpoint
CREATE TABLE `__new_planned_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
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
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recurrence_rule_id`) REFERENCES `recurrence_rules`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `planned_payments_amount_nonnegative` CHECK(`expected_amount_minor` >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_planned_payments` SELECT `id`,`user_id`,`title`,`direction`,`expected_amount_minor`,`currency`,`due_date`,`account_id`,`category_id`,`merchant_id`,`recurrence_rule_id`,`notes`,`spending_nature`,`spending_priority`,`active`,`archived_at`,`created_at`,`updated_at` FROM `planned_payments`;
--> statement-breakpoint
DROP TABLE `planned_payments`;
--> statement-breakpoint
ALTER TABLE `__new_planned_payments` RENAME TO `planned_payments`;
--> statement-breakpoint
CREATE INDEX `planned_payments_workspace_due_idx` ON `planned_payments` (`workspace_id`,`due_date`);
--> statement-breakpoint
CREATE TABLE `__new_credit_card_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
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
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`statement_id`) REFERENCES `credit_card_statements`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`card_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `credit_card_payment_amount_positive` CHECK(`amount_minor` > 0)
);
--> statement-breakpoint
INSERT INTO `__new_credit_card_payments` SELECT `id`,`user_id`,`account_id`,`source_account_id`,`statement_id`,`payment_date`,`amount_minor`,`transfer_group_id`,`source_transaction_id`,`card_transaction_id`,`voided_at`,`created_at`,`updated_at` FROM `credit_card_payments`;
--> statement-breakpoint
DROP TABLE `credit_card_payments`;
--> statement-breakpoint
ALTER TABLE `__new_credit_card_payments` RENAME TO `credit_card_payments`;
--> statement-breakpoint
CREATE INDEX `credit_card_payments_account_date_idx` ON `credit_card_payments` (`account_id`,`payment_date`);
--> statement-breakpoint
CREATE TABLE `__new_loan_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
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
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`loan_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`schedule_entry_id`) REFERENCES `loan_schedule_entries`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_principal_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`loan_principal_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`interest_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`fee_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `loan_payment_allocation_valid` CHECK(`total_minor` > 0 AND `principal_minor` >= 0 AND `interest_minor` >= 0 AND `fees_minor` >= 0 AND `total_minor` = `principal_minor` + `interest_minor` + `fees_minor`)
);
--> statement-breakpoint
INSERT INTO `__new_loan_payments` SELECT `id`,`user_id`,`loan_account_id`,`source_account_id`,`schedule_entry_id`,`payment_date`,`total_minor`,`principal_minor`,`interest_minor`,`fees_minor`,`principal_transfer_group_id`,`source_principal_transaction_id`,`loan_principal_transaction_id`,`interest_transaction_id`,`fee_transaction_id`,`notes`,`voided_at`,`created_at`,`updated_at` FROM `loan_payments`;
--> statement-breakpoint
DROP TABLE `loan_payments`;
--> statement-breakpoint
ALTER TABLE `__new_loan_payments` RENAME TO `loan_payments`;
--> statement-breakpoint
CREATE INDEX `loan_payments_account_date_idx` ON `loan_payments` (`loan_account_id`,`payment_date`);
--> statement-breakpoint
CREATE TABLE `__new_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`month` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`category_id` text,
	`amount_minor` integer NOT NULL,
	`rollover` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `budgets_amount_nonnegative` CHECK(`amount_minor` >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_budgets` SELECT `id`,`user_id`,`month`,`currency`,`category_id`,`amount_minor`,`rollover`,`notes`,`created_at`,`updated_at` FROM `budgets`;
--> statement-breakpoint
DROP TABLE `budgets`;
--> statement-breakpoint
ALTER TABLE `__new_budgets` RENAME TO `budgets`;
--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_workspace_month_category_unique` ON `budgets` (`workspace_id`,`month`,`category_id`);
--> statement-breakpoint
CREATE TABLE `__new_month_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`month` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`name` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`expected_income_minor` integer DEFAULT 0 NOT NULL,
	`discretionary_target_minor` integer,
	`copied_from_plan_id` text,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`copied_from_plan_id`) REFERENCES `month_plans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_month_plans` SELECT `id`,`user_id`,`month`,`currency`,`name`,`status`,`expected_income_minor`,`discretionary_target_minor`,`copied_from_plan_id`,`notes`,`created_at`,`updated_at` FROM `month_plans`;
--> statement-breakpoint
DROP TABLE `month_plans`;
--> statement-breakpoint
ALTER TABLE `__new_month_plans` RENAME TO `month_plans`;
--> statement-breakpoint
CREATE UNIQUE INDEX `month_plans_workspace_month_unique` ON `month_plans` (`workspace_id`,`month`);
--> statement-breakpoint
CREATE TABLE `__new_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`transaction_id` text,
	`planned_payment_id` text,
	`file_name` text NOT NULL,
	`storage_path` text,
	`external_reference` text,
	`mime_type` text,
	`size_bytes` integer,
	`sha256` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`planned_payment_id`) REFERENCES `planned_payments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `attachments_owner_check` CHECK((`transaction_id` IS NOT NULL) <> (`planned_payment_id` IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_attachments` SELECT `id`,`user_id`,`transaction_id`,`planned_payment_id`,`file_name`,`storage_path`,`external_reference`,`mime_type`,`size_bytes`,`sha256`,`created_at` FROM `attachments`;
--> statement-breakpoint
DROP TABLE `attachments`;
--> statement-breakpoint
ALTER TABLE `__new_attachments` RENAME TO `attachments`;
--> statement-breakpoint
CREATE INDEX `attachments_workspace_created_idx` ON `attachments` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `attachments_transaction_idx` ON `attachments` (`transaction_id`);
--> statement-breakpoint
CREATE INDEX `attachments_planned_payment_idx` ON `attachments` (`planned_payment_id`);
--> statement-breakpoint
CREATE TABLE `__new_import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
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
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_import_batches` SELECT `id`,`user_id`,`account_id`,`file_name`,`status`,`column_mapping`,`total_rows`,`imported_rows`,`duplicate_rows`,`invalid_rows`,`errors`,`created_at`,`completed_at` FROM `import_batches`;
--> statement-breakpoint
DROP TABLE `import_batches`;
--> statement-breakpoint
ALTER TABLE `__new_import_batches` RENAME TO `import_batches`;
--> statement-breakpoint
CREATE INDEX `import_batches_workspace_created_idx` ON `import_batches` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `__new_audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`actor_user_id` text,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before` text,
	`after` text,
	`metadata` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_audit_logs` SELECT `id`,`user_id`,`user_id`,`entity_type`,`entity_id`,`action`,`before`,`after`,`metadata`,`created_at` FROM `audit_logs`;
--> statement-breakpoint
DROP TABLE `audit_logs`;
--> statement-breakpoint
ALTER TABLE `__new_audit_logs` RENAME TO `audit_logs`;
--> statement-breakpoint
CREATE INDEX `audit_logs_workspace_created_idx` ON `audit_logs` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `audit_logs_actor_created_idx` ON `audit_logs` (`actor_user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `workspace_members_personal_insert_guard`
BEFORE INSERT ON `workspace_members`
WHEN (SELECT `type` FROM `workspaces` WHERE `id` = NEW.`workspace_id`) = 'personal'
 AND (NEW.`role` <> 'owner' OR NEW.`user_id` <> NEW.`workspace_id`
      OR EXISTS (SELECT 1 FROM `workspace_members` WHERE `workspace_id` = NEW.`workspace_id`))
BEGIN
	SELECT RAISE(ABORT, 'personal workspace membership is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_members_personal_update_guard`
BEFORE UPDATE ON `workspace_members`
WHEN (SELECT `type` FROM `workspaces` WHERE `id` = OLD.`workspace_id`) = 'personal'
  OR (SELECT `type` FROM `workspaces` WHERE `id` = NEW.`workspace_id`) = 'personal'
BEGIN
	SELECT RAISE(ABORT, 'personal workspace membership is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_members_personal_delete_guard`
BEFORE DELETE ON `workspace_members`
WHEN (SELECT `type` FROM `workspaces` WHERE `id` = OLD.`workspace_id`) = 'personal'
 AND EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
 AND EXISTS (SELECT 1 FROM `users` WHERE `id` = OLD.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'personal workspace membership is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_members_last_owner_delete_guard`
BEFORE DELETE ON `workspace_members`
WHEN OLD.`role` = 'owner'
 AND (SELECT `type` FROM `workspaces` WHERE `id` = OLD.`workspace_id`) = 'household'
 AND EXISTS (SELECT 1 FROM `workspaces` WHERE `id` = OLD.`workspace_id`)
 AND (SELECT count(*) FROM `workspace_members` WHERE `workspace_id` = OLD.`workspace_id` AND `role` = 'owner') = 1
BEGIN
	SELECT RAISE(ABORT, 'workspace must retain an owner');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_members_last_owner_update_guard`
BEFORE UPDATE OF `workspace_id`, `role` ON `workspace_members`
WHEN OLD.`role` = 'owner'
 AND (NEW.`role` <> 'owner' OR NEW.`workspace_id` <> OLD.`workspace_id`)
 AND (SELECT count(*) FROM `workspace_members` WHERE `workspace_id` = OLD.`workspace_id` AND `role` = 'owner') = 1
BEGIN
	SELECT RAISE(ABORT, 'workspace must retain an owner');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_invitations_personal_insert_guard`
BEFORE INSERT ON `workspace_invitations`
WHEN (SELECT `type` FROM `workspaces` WHERE `id` = NEW.`workspace_id`) = 'personal'
BEGIN
	SELECT RAISE(ABORT, 'personal workspaces cannot issue invitations');
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_invitations_personal_update_guard`
BEFORE UPDATE OF `workspace_id` ON `workspace_invitations`
WHEN (SELECT `type` FROM `workspaces` WHERE `id` = NEW.`workspace_id`) = 'personal'
BEGIN
	SELECT RAISE(ABORT, 'personal workspaces cannot issue invitations');
END;
--> statement-breakpoint
CREATE TRIGGER `users_personal_workspace_cleanup`
AFTER DELETE ON `users`
BEGIN
	DELETE FROM `workspaces` WHERE `id` = OLD.`id` AND `type` = 'personal';
END;
--> statement-breakpoint
CREATE TEMP TABLE `__migration_fk_guard` (
	`violation` integer NOT NULL CHECK (`violation` = 0)
);
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `workspaces` w
WHERE (w.`type` = 'household' AND NOT EXISTS (
	SELECT 1 FROM `workspace_members` m
	WHERE m.`workspace_id` = w.`id` AND m.`role` = 'owner'
)) OR (w.`type` = 'personal' AND (
	(SELECT count(*) FROM `workspace_members` m WHERE m.`workspace_id` = w.`id`) <> 1
	OR NOT EXISTS (
		SELECT 1 FROM `workspace_members` m
		WHERE m.`workspace_id` = w.`id` AND m.`user_id` = w.`id` AND m.`role` = 'owner'
	)
)) LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `users` u
WHERE NOT EXISTS (
	SELECT 1 FROM `workspaces` w
	JOIN `workspace_members` m ON m.`workspace_id` = w.`id`
	WHERE w.`id` = u.`id` AND w.`type` = 'personal'
	  AND m.`user_id` = u.`id` AND m.`role` = 'owner'
) LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `workspace_invitations` i
JOIN `workspaces` w ON w.`id` = i.`workspace_id`
WHERE w.`type` <> 'household' LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `sessions` s
LEFT JOIN `workspace_members` m
	ON m.`workspace_id` = s.`active_workspace_id` AND m.`user_id` = s.`user_id`
WHERE s.`active_workspace_id` IS NOT NULL AND m.`user_id` IS NULL LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `categories` c
JOIN `categories` parent ON parent.`id` = c.`parent_id`
WHERE c.`workspace_id` <> parent.`workspace_id` LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `merchants` m
JOIN `categories` c ON c.`id` = m.`default_category_id`
WHERE m.`workspace_id` <> c.`workspace_id` LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `transactions` t
JOIN `accounts` a ON a.`id` = t.`account_id`
LEFT JOIN `categories` c ON c.`id` = t.`category_id`
LEFT JOIN `merchants` m ON m.`id` = t.`merchant_id`
WHERE t.`workspace_id` <> a.`workspace_id`
	OR (t.`category_id` IS NOT NULL AND t.`workspace_id` <> c.`workspace_id`)
	OR (t.`merchant_id` IS NOT NULL AND t.`workspace_id` <> m.`workspace_id`)
LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `transactions` t
LEFT JOIN `transactions` peer ON peer.`id` = t.`transfer_peer_id`
WHERE t.`transfer_peer_id` IS NOT NULL
	AND (peer.`id` IS NULL OR peer.`workspace_id` <> t.`workspace_id`)
LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `transactions` t
LEFT JOIN `planned_payment_occurrences` o ON o.`id` = t.`planned_occurrence_id`
LEFT JOIN `planned_payments` p ON p.`id` = o.`planned_payment_id`
WHERE t.`planned_occurrence_id` IS NOT NULL
	AND (o.`id` IS NULL OR p.`workspace_id` <> t.`workspace_id`)
LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `transaction_splits` s
JOIN `transactions` t ON t.`id` = s.`transaction_id`
JOIN `categories` c ON c.`id` = s.`category_id`
WHERE t.`workspace_id` <> c.`workspace_id` LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `transaction_tags` x
JOIN `transactions` t ON t.`id` = x.`transaction_id`
JOIN `tags` tag ON tag.`id` = x.`tag_id`
WHERE t.`workspace_id` <> tag.`workspace_id` LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `planned_payments` p
LEFT JOIN `accounts` a ON a.`id` = p.`account_id`
LEFT JOIN `categories` c ON c.`id` = p.`category_id`
LEFT JOIN `merchants` m ON m.`id` = p.`merchant_id`
LEFT JOIN `recurrence_rules` r ON r.`id` = p.`recurrence_rule_id`
WHERE (p.`account_id` IS NOT NULL AND p.`workspace_id` <> a.`workspace_id`)
	OR (p.`category_id` IS NOT NULL AND p.`workspace_id` <> c.`workspace_id`)
	OR (p.`merchant_id` IS NOT NULL AND p.`workspace_id` <> m.`workspace_id`)
	OR (p.`recurrence_rule_id` IS NOT NULL AND p.`workspace_id` <> r.`workspace_id`)
LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `planned_payment_transactions` x
JOIN `planned_payment_occurrences` o ON o.`id` = x.`occurrence_id`
JOIN `planned_payments` p ON p.`id` = o.`planned_payment_id`
JOIN `transactions` t ON t.`id` = x.`transaction_id`
WHERE p.`workspace_id` <> t.`workspace_id` LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `credit_card_payments` p
JOIN `accounts` card ON card.`id` = p.`account_id`
JOIN `accounts` source ON source.`id` = p.`source_account_id`
LEFT JOIN `credit_card_statements` statement ON statement.`id` = p.`statement_id`
LEFT JOIN `accounts` statement_account ON statement_account.`id` = statement.`account_id`
JOIN `transactions` source_transaction ON source_transaction.`id` = p.`source_transaction_id`
JOIN `transactions` card_transaction ON card_transaction.`id` = p.`card_transaction_id`
WHERE p.`workspace_id` <> card.`workspace_id`
	OR p.`workspace_id` <> source.`workspace_id`
	OR p.`workspace_id` <> source_transaction.`workspace_id`
	OR p.`workspace_id` <> card_transaction.`workspace_id`
	OR (p.`statement_id` IS NOT NULL AND p.`workspace_id` <> statement_account.`workspace_id`)
LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `loan_profiles` p
JOIN `accounts` loan ON loan.`id` = p.`account_id`
LEFT JOIN `accounts` payment ON payment.`id` = p.`payment_account_id`
LEFT JOIN `categories` interest ON interest.`id` = p.`interest_category_id`
LEFT JOIN `categories` fee ON fee.`id` = p.`fee_category_id`
WHERE (p.`payment_account_id` IS NOT NULL AND loan.`workspace_id` <> payment.`workspace_id`)
	OR (p.`interest_category_id` IS NOT NULL AND loan.`workspace_id` <> interest.`workspace_id`)
	OR (p.`fee_category_id` IS NOT NULL AND loan.`workspace_id` <> fee.`workspace_id`)
LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `loan_payments` p
JOIN `accounts` loan ON loan.`id` = p.`loan_account_id`
JOIN `accounts` source ON source.`id` = p.`source_account_id`
LEFT JOIN `loan_schedule_entries` schedule ON schedule.`id` = p.`schedule_entry_id`
LEFT JOIN `accounts` schedule_loan ON schedule_loan.`id` = schedule.`loan_account_id`
LEFT JOIN `transactions` source_principal ON source_principal.`id` = p.`source_principal_transaction_id`
LEFT JOIN `transactions` loan_principal ON loan_principal.`id` = p.`loan_principal_transaction_id`
LEFT JOIN `transactions` interest ON interest.`id` = p.`interest_transaction_id`
LEFT JOIN `transactions` fee ON fee.`id` = p.`fee_transaction_id`
WHERE p.`workspace_id` <> loan.`workspace_id`
	OR p.`workspace_id` <> source.`workspace_id`
	OR (p.`schedule_entry_id` IS NOT NULL AND p.`workspace_id` <> schedule_loan.`workspace_id`)
	OR (p.`source_principal_transaction_id` IS NOT NULL AND p.`workspace_id` <> source_principal.`workspace_id`)
	OR (p.`loan_principal_transaction_id` IS NOT NULL AND p.`workspace_id` <> loan_principal.`workspace_id`)
	OR (p.`interest_transaction_id` IS NOT NULL AND p.`workspace_id` <> interest.`workspace_id`)
	OR (p.`fee_transaction_id` IS NOT NULL AND p.`workspace_id` <> fee.`workspace_id`)
LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `budgets` b
JOIN `categories` c ON c.`id` = b.`category_id`
WHERE b.`workspace_id` <> c.`workspace_id` LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `month_plans` p
JOIN `month_plans` source ON source.`id` = p.`copied_from_plan_id`
WHERE p.`workspace_id` <> source.`workspace_id` LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `month_plan_accounts` x
JOIN `month_plans` p ON p.`id` = x.`month_plan_id`
JOIN `accounts` a ON a.`id` = x.`account_id`
WHERE p.`workspace_id` <> a.`workspace_id` LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `month_plan_items` i
JOIN `month_plans` plan ON plan.`id` = i.`month_plan_id`
LEFT JOIN `planned_payments` payment ON payment.`id` = i.`planned_payment_id`
LEFT JOIN `planned_payment_occurrences` occurrence ON occurrence.`id` = i.`occurrence_id`
LEFT JOIN `planned_payments` occurrence_payment ON occurrence_payment.`id` = occurrence.`planned_payment_id`
LEFT JOIN `accounts` account ON account.`id` = i.`account_id`
LEFT JOIN `categories` category ON category.`id` = i.`category_id`
WHERE (i.`planned_payment_id` IS NOT NULL AND plan.`workspace_id` <> payment.`workspace_id`)
	OR (i.`occurrence_id` IS NOT NULL AND plan.`workspace_id` <> occurrence_payment.`workspace_id`)
	OR (i.`account_id` IS NOT NULL AND plan.`workspace_id` <> account.`workspace_id`)
	OR (i.`category_id` IS NOT NULL AND plan.`workspace_id` <> category.`workspace_id`)
	OR (i.`planned_payment_id` IS NOT NULL AND i.`occurrence_id` IS NOT NULL
		AND occurrence.`planned_payment_id` <> i.`planned_payment_id`)
LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `scenario_adjustments` a
JOIN `plan_scenarios` scenario ON scenario.`id` = a.`scenario_id`
JOIN `month_plans` plan ON plan.`id` = scenario.`month_plan_id`
LEFT JOIN `month_plan_items` item ON item.`id` = a.`month_plan_item_id`
LEFT JOIN `month_plans` item_plan ON item_plan.`id` = item.`month_plan_id`
LEFT JOIN `accounts` account ON account.`id` = a.`account_id`
WHERE (a.`month_plan_item_id` IS NOT NULL AND plan.`workspace_id` <> item_plan.`workspace_id`)
	OR (a.`account_id` IS NOT NULL AND plan.`workspace_id` <> account.`workspace_id`)
LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `attachments` a
LEFT JOIN `transactions` t ON t.`id` = a.`transaction_id`
LEFT JOIN `planned_payments` p ON p.`id` = a.`planned_payment_id`
WHERE (a.`transaction_id` IS NOT NULL AND a.`workspace_id` <> t.`workspace_id`)
	OR (a.`planned_payment_id` IS NOT NULL AND a.`workspace_id` <> p.`workspace_id`)
LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `import_batches` b
JOIN `accounts` a ON a.`id` = b.`account_id`
WHERE b.`workspace_id` <> a.`workspace_id` LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM `import_records` r
JOIN `import_batches` b ON b.`id` = r.`batch_id`
LEFT JOIN `transactions` duplicate ON duplicate.`id` = r.`duplicate_of_transaction_id`
LEFT JOIN `transactions` posted ON posted.`id` = r.`transaction_id`
WHERE (r.`duplicate_of_transaction_id` IS NOT NULL AND b.`workspace_id` <> duplicate.`workspace_id`)
	OR (r.`transaction_id` IS NOT NULL AND b.`workspace_id` <> posted.`workspace_id`)
LIMIT 1;
--> statement-breakpoint
INSERT INTO `__migration_fk_guard` (`violation`)
SELECT 1 FROM pragma_foreign_key_check LIMIT 1;
--> statement-breakpoint
DROP TABLE `__migration_fk_guard`;
--> statement-breakpoint
PRAGMA foreign_keys = ON;
