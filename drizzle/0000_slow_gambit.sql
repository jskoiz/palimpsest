CREATE TABLE `artworks` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`tile_width` integer NOT NULL,
	`tile_height` integer NOT NULL,
	`columns` integer NOT NULL,
	`rows` integer NOT NULL,
	`head_revision_id` text,
	`head_sequence` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artworks_slug_unique` ON `artworks` (`slug`);--> statement-breakpoint
CREATE TABLE `authors` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blobs` (
	`id` text PRIMARY KEY NOT NULL,
	`artwork_id` text NOT NULL,
	`kind` text NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_length` integer NOT NULL,
	`sha256` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artwork_id`) REFERENCES `artworks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blobs_r2_key_unique` ON `blobs` (`r2_key`);--> statement-breakpoint
CREATE INDEX `blobs_artwork_kind_idx` ON `blobs` (`artwork_id`,`kind`);--> statement-breakpoint
CREATE TABLE `edit_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`artwork_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`execution_mode` text NOT NULL,
	`author_id` text NOT NULL,
	`requester_hash` text NOT NULL,
	`base_revision_id` text NOT NULL,
	`target_revision_id` text,
	`prompt` text NOT NULL,
	`tile_x` integer,
	`tile_y` integer,
	`region_x` integer,
	`region_y` integer,
	`region_width` integer,
	`region_height` integer,
	`source_blob_id` text,
	`mask_blob_id` text,
	`display_mask_blob_id` text,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`worker_token` text,
	`lock_fence` integer,
	`lease_expires_at` integer,
	`result_revision_id` text,
	`openai_request_id` text,
	`error_code` text,
	`public_error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`artwork_id`) REFERENCES `artworks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `edit_jobs_artwork_idempotency_uq` ON `edit_jobs` (`artwork_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `edit_jobs_queue_idx` ON `edit_jobs` (`artwork_id`,`state`,`available_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `edit_jobs_requester_idx` ON `edit_jobs` (`requester_hash`,`state`);--> statement-breakpoint
CREATE TABLE `keyframe_tiles` (
	`keyframe_id` text NOT NULL,
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`blob_id` text NOT NULL,
	PRIMARY KEY(`keyframe_id`, `tile_x`, `tile_y`),
	FOREIGN KEY (`keyframe_id`) REFERENCES `keyframes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blob_id`) REFERENCES `blobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `keyframes` (
	`id` text PRIMARY KEY NOT NULL,
	`artwork_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artwork_id`) REFERENCES `artworks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revision_id`) REFERENCES `revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `keyframes_artwork_sequence_uq` ON `keyframes` (`artwork_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `queue_locks` (
	`artwork_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`owner_token` text,
	`fence` integer DEFAULT 0 NOT NULL,
	`job_id` text,
	`acquired_at` integer,
	`heartbeat_at` integer,
	`lease_expires_at` integer,
	FOREIGN KEY (`artwork_id`) REFERENCES `artworks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rate_windows` (
	`requester_hash` text NOT NULL,
	`scope` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`requester_hash`, `scope`, `window_start`)
);
--> statement-breakpoint
CREATE TABLE `revision_patches` (
	`revision_id` text NOT NULL,
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`patch_blob_id` text NOT NULL,
	`display_mask_blob_id` text,
	PRIMARY KEY(`revision_id`, `tile_x`, `tile_y`),
	FOREIGN KEY (`revision_id`) REFERENCES `revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`patch_blob_id`) REFERENCES `blobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`display_mask_blob_id`) REFERENCES `blobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`artwork_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`parent_revision_id` text,
	`job_id` text,
	`origin` text NOT NULL,
	`status` text NOT NULL,
	`author_id` text NOT NULL,
	`prompt` text NOT NULL,
	`region_x` integer,
	`region_y` integer,
	`region_width` integer,
	`region_height` integer,
	`tile_x` integer,
	`tile_y` integer,
	`revert_target_revision_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artwork_id`) REFERENCES `artworks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `revisions_job_id_unique` ON `revisions` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `revisions_artwork_sequence_uq` ON `revisions` (`artwork_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `revisions_artwork_created_idx` ON `revisions` (`artwork_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `revisions_immutable_update`
BEFORE UPDATE ON `revisions`
BEGIN SELECT RAISE(ABORT, 'accepted revisions are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `revisions_immutable_delete`
BEFORE DELETE ON `revisions`
BEGIN SELECT RAISE(ABORT, 'accepted revisions are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `revisions_require_current_parent`
BEFORE INSERT ON `revisions`
WHEN NEW.sequence > 0 AND NEW.job_id IS NOT NULL AND (
  SELECT head_revision_id FROM artworks WHERE id = NEW.artwork_id
) IS NOT NEW.parent_revision_id
BEGIN SELECT RAISE(ABORT, 'stale base revision'); END;
