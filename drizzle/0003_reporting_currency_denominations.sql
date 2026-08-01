ALTER TABLE `budgets` ADD `currency` text DEFAULT 'USD' NOT NULL;
--> statement-breakpoint
UPDATE `budgets`
   SET `currency` = COALESCE(
     (SELECT `default_currency` FROM `users` WHERE `users`.`id` = `budgets`.`user_id`),
     'USD'
   );
--> statement-breakpoint
ALTER TABLE `month_plans` ADD `currency` text DEFAULT 'USD' NOT NULL;
--> statement-breakpoint
UPDATE `month_plans`
   SET `currency` = COALESCE(
     (SELECT `default_currency` FROM `users` WHERE `users`.`id` = `month_plans`.`user_id`),
     'USD'
   );
