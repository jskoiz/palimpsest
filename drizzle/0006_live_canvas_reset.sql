DELETE FROM `revision_patches`
WHERE `revision_id` IN (
  SELECT `id` FROM `revisions` WHERE `artwork_id` = 'palimpsest'
);--> statement-breakpoint
DELETE FROM `keyframe_tiles`
WHERE `keyframe_id` IN (
  SELECT `id` FROM `keyframes` WHERE `artwork_id` = 'palimpsest'
);--> statement-breakpoint
DELETE FROM `edit_jobs` WHERE `artwork_id` = 'palimpsest';--> statement-breakpoint
DELETE FROM `artwork_commit_locks` WHERE `artwork_id` = 'palimpsest';--> statement-breakpoint
DELETE FROM `keyframes` WHERE `artwork_id` = 'palimpsest';--> statement-breakpoint
DROP TRIGGER `revisions_immutable_delete`;--> statement-breakpoint
DELETE FROM `revisions` WHERE `artwork_id` = 'palimpsest';--> statement-breakpoint
CREATE TRIGGER `revisions_immutable_delete`
BEFORE DELETE ON `revisions`
BEGIN SELECT RAISE(ABORT, 'accepted revisions are immutable'); END;--> statement-breakpoint
DELETE FROM `blobs` WHERE `artwork_id` = 'palimpsest';--> statement-breakpoint
DELETE FROM `artworks` WHERE `id` = 'palimpsest';--> statement-breakpoint
DELETE FROM `authors`
WHERE `id` NOT IN (SELECT `author_id` FROM `revisions`)
  AND `id` NOT IN (SELECT `author_id` FROM `edit_jobs`);--> statement-breakpoint
DELETE FROM `rate_windows`;
