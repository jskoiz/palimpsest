CREATE TABLE `visitor_events` (
	`id` text PRIMARY KEY NOT NULL,
	`visitor_hash` text NOT NULL,
	`session_id` text,
	`event_type` text NOT NULL,
	`path` text NOT NULL,
	`country` text,
	`user_agent` text,
	`job_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `edit_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `visitor_events_created_idx` ON `visitor_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `visitor_events_visitor_created_idx` ON `visitor_events` (`visitor_hash`,`created_at`);
