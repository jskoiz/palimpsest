ALTER TABLE `queue_locks` RENAME TO `artwork_commit_locks`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_artwork_commit_locks` (
	`artwork_id` text PRIMARY KEY NOT NULL,
	`owner_token` text,
	`fence` integer DEFAULT 0 NOT NULL,
	`job_id` text,
	`acquired_at` integer,
	`lease_expires_at` integer,
	FOREIGN KEY (`artwork_id`) REFERENCES `artworks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_artwork_commit_locks`("artwork_id", "owner_token", "fence", "job_id", "acquired_at", "lease_expires_at") SELECT "artwork_id", NULL, "fence", NULL, NULL, NULL FROM `artwork_commit_locks`;--> statement-breakpoint
DROP TABLE `artwork_commit_locks`;--> statement-breakpoint
ALTER TABLE `__new_artwork_commit_locks` RENAME TO `artwork_commit_locks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_edit_jobs` (
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
	`region_x` integer,
	`region_y` integer,
	`region_width` integer,
	`region_height` integer,
	`frame_x` integer,
	`frame_y` integer,
	`frame_width` integer,
	`frame_height` integer,
	`source_blob_id` text,
	`mask_blob_id` text,
	`display_mask_blob_id` text,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`worker_token` text,
	`lease_fence` integer DEFAULT 0 NOT NULL,
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
INSERT INTO `__new_edit_jobs`(
	"id", "artwork_id", "kind", "state", "execution_mode", "author_id", "requester_hash",
	"base_revision_id", "target_revision_id", "prompt", "region_x", "region_y", "region_width",
	"region_height", "frame_x", "frame_y", "frame_width", "frame_height", "source_blob_id",
	"mask_blob_id", "display_mask_blob_id", "idempotency_key", "request_fingerprint",
	"attempt_count", "available_at", "worker_token", "lease_fence", "lease_expires_at",
	"result_revision_id", "openai_request_id", "error_code", "public_error_message",
	"created_at", "updated_at", "started_at", "completed_at"
) SELECT
	"id", "artwork_id", "kind",
	CASE WHEN "state" IN ('queued', 'moderating', 'generating', 'committing') THEN 'failed' ELSE "state" END,
	"execution_mode", "author_id", "requester_hash", "base_revision_id", "target_revision_id", "prompt",
	CASE WHEN "kind" = 'revert' THEN 0 ELSE "region_x" + COALESCE("tile_x", 0) * 1024 END,
	CASE WHEN "kind" = 'revert' THEN 0 ELSE "region_y" + COALESCE("tile_y", 0) * 1024 END,
	CASE WHEN "kind" = 'revert' THEN 2048 ELSE "region_width" END,
	CASE WHEN "kind" = 'revert' THEN 2048 ELSE "region_height" END,
	CASE WHEN "kind" = 'edit' THEN COALESCE("tile_x", 0) * 1024 ELSE NULL END,
	CASE WHEN "kind" = 'edit' THEN COALESCE("tile_y", 0) * 1024 ELSE NULL END,
	CASE WHEN "kind" = 'edit' THEN 1024 ELSE NULL END,
	CASE WHEN "kind" = 'edit' THEN 1024 ELSE NULL END,
	"source_blob_id", "mask_blob_id", "display_mask_blob_id", "idempotency_key", "request_fingerprint",
	"attempt_count", "available_at", NULL, COALESCE("lock_fence", 0), NULL,
	"result_revision_id", "openai_request_id",
	CASE WHEN "state" IN ('queued', 'moderating', 'generating', 'committing') THEN 'QUEUE_SCHEMA_UPGRADED' ELSE "error_code" END,
	CASE WHEN "state" IN ('queued', 'moderating', 'generating', 'committing')
		THEN 'This queued edit used an obsolete tile-local format and was safely released. Nothing was added to history.'
		ELSE "public_error_message" END,
	"created_at", "updated_at", "started_at",
	CASE WHEN "state" IN ('queued', 'moderating', 'generating', 'committing') THEN "updated_at" ELSE "completed_at" END
FROM `edit_jobs`;--> statement-breakpoint
DROP TABLE `edit_jobs`;--> statement-breakpoint
ALTER TABLE `__new_edit_jobs` RENAME TO `edit_jobs`;--> statement-breakpoint
CREATE UNIQUE INDEX `edit_jobs_artwork_idempotency_uq` ON `edit_jobs` (`artwork_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `edit_jobs_queue_idx` ON `edit_jobs` (`artwork_id`,`state`,`available_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `edit_jobs_reservation_idx` ON `edit_jobs` (`artwork_id`,`state`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `__new_revision_patches` (
	`revision_id` text PRIMARY KEY NOT NULL,
	`patch_blob_id` text NOT NULL,
	`display_mask_blob_id` text,
	`frame_x` integer NOT NULL,
	`frame_y` integer NOT NULL,
	`frame_width` integer NOT NULL,
	`frame_height` integer NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`patch_blob_id`) REFERENCES `blobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`display_mask_blob_id`) REFERENCES `blobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_revision_patches`("revision_id", "patch_blob_id", "display_mask_blob_id", "frame_x", "frame_y", "frame_width", "frame_height")
SELECT "revision_id", "patch_blob_id", "display_mask_blob_id", "tile_x" * 1024, "tile_y" * 1024, 1024, 1024 FROM `revision_patches`;--> statement-breakpoint
DROP TABLE `revision_patches`;--> statement-breakpoint
ALTER TABLE `__new_revision_patches` RENAME TO `revision_patches`;--> statement-breakpoint
DROP TRIGGER `revisions_immutable_update`;--> statement-breakpoint
DROP TRIGGER `revisions_immutable_delete`;--> statement-breakpoint
DROP TRIGGER `revisions_require_current_parent`;--> statement-breakpoint
UPDATE `revisions`
SET `region_x` = 0,
    `region_y` = 0,
    `region_width` = 2048,
    `region_height` = 2048
WHERE `origin` = 'revert';--> statement-breakpoint
UPDATE `revisions`
SET `region_x` = `region_x` + COALESCE(`tile_x`, 0) * 1024,
    `region_y` = `region_y` + COALESCE(`tile_y`, 0) * 1024
WHERE `region_x` IS NOT NULL AND `origin` <> 'revert';--> statement-breakpoint
ALTER TABLE `revisions` DROP COLUMN `tile_x`;--> statement-breakpoint
ALTER TABLE `revisions` DROP COLUMN `tile_y`;--> statement-breakpoint
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
BEGIN SELECT RAISE(ABORT, 'stale parent revision'); END;
