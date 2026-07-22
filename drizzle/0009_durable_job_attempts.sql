ALTER TABLE `edit_jobs` ADD `retry_of_job_id` text;--> statement-breakpoint
ALTER TABLE `edit_jobs` ADD `retry_token_hash` text;--> statement-breakpoint
ALTER TABLE `edit_jobs` ADD `request_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `edit_jobs_retry_of_uq` ON `edit_jobs` (`retry_of_job_id`);--> statement-breakpoint
CREATE INDEX `edit_jobs_activity_idx` ON `edit_jobs` (`artwork_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `rate_limit_claims` (
	`requester_hash` text NOT NULL,
	`scope` text NOT NULL,
	`window_start` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`job_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`requester_hash`, `scope`, `window_start`, `idempotency_key`)
);--> statement-breakpoint
DROP TABLE IF EXISTS `rate_windows`;--> statement-breakpoint
