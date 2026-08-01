ALTER TABLE `transactions` ADD `original_amount_minor` integer;
--> statement-breakpoint
ALTER TABLE `transactions` ADD `original_currency` text;
--> statement-breakpoint
ALTER TABLE `transactions` ADD `fx_rate_scaled` integer;
--> statement-breakpoint
ALTER TABLE `transactions` ADD `fx_rate_source` text;
--> statement-breakpoint
ALTER TABLE `transactions` ADD `fx_rate_date` text;
--> statement-breakpoint
ALTER TABLE `transactions` ADD `reference_fx_rate_scaled` integer;
--> statement-breakpoint
ALTER TABLE `transactions` ADD `reference_fx_rate_date` text;
--> statement-breakpoint
CREATE TABLE `fx_rate_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`rate_date` text NOT NULL,
	`currency` text NOT NULL,
	`published_rate_scaled` integer NOT NULL,
	`multiplier` integer DEFAULT 1 NOT NULL,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL,
	CONSTRAINT `fx_rate_observations_values_positive` CHECK(`published_rate_scaled` > 0 AND `multiplier` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fx_rate_observations_date_currency_unique` ON `fx_rate_observations` (`rate_date`,`currency`);
--> statement-breakpoint
CREATE INDEX `fx_rate_observations_currency_date_idx` ON `fx_rate_observations` (`currency`,`rate_date`);
--> statement-breakpoint
CREATE TABLE `fx_sync_metadata` (
	`year` integer PRIMARY KEY NOT NULL,
	`source_url` text NOT NULL,
	`publishing_date` text,
	`first_observation_date` text,
	`last_observation_date` text,
	`observation_count` integer DEFAULT 0 NOT NULL,
	`fetched_at` text NOT NULL
);
