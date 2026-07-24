CREATE TABLE `_cleanup_0013_guard` (
	`ok` integer NOT NULL CHECK (`ok` = 1)
);
--> statement-breakpoint
INSERT INTO `_cleanup_0013_guard` (`ok`)
SELECT CASE WHEN
	EXISTS (
		SELECT 1
		FROM `artworks`
		WHERE `id` = 'palimpsest-purple'
			AND `head_revision_id` = '5068a183-cb54-4e38-996b-ea3b1179f32c'
			AND `head_sequence` = 6
	)
	AND (
		SELECT COUNT(*)
		FROM `revisions`
		WHERE `artwork_id` = 'palimpsest-purple'
			AND `id` IN (
				'ee06571d-e36b-4443-bf6a-ec150d65fee0',
				'ec0166ea-26b2-4565-959b-454e68ccb29b',
				'6dd5039b-416e-419f-87e8-7a21b1bb0426',
				'5068a183-cb54-4e38-996b-ea3b1179f32c'
			)
	) = 4
THEN 1 ELSE 0 END;
--> statement-breakpoint
CREATE TABLE `_cleanup_0013_blobs` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `_cleanup_0013_blobs` (`id`)
SELECT `source_blob_id`
FROM `edit_jobs`
WHERE `id` IN (
	'52e44704-48d0-49b6-81cf-416d8fa87be3',
	'52529bdd-ab6e-42b7-9e1e-10cf682664ef',
	'fbfcb2e2-c602-486e-91bf-0b9596dd0ac8',
	'960a9151-2381-4dbc-9667-76b292a7a606',
	'ac4b7653-98f3-4c4d-9c6d-3ad53ee3cffa',
	'52a0ea9a-22e4-4b28-9f94-312d9e27f32a',
	'9ef638a5-16cd-4b3d-8678-7338d27b6095',
	'abd4230f-7a43-4d8b-a66d-e667d37ea3c5',
	'f63a84a2-2029-4154-8126-317d0654a515',
	'7fe30312-b131-4da3-81d5-23c0d52d2f3f'
)
	AND `source_blob_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `_cleanup_0013_blobs` (`id`)
SELECT `mask_blob_id`
FROM `edit_jobs`
WHERE `id` IN (
	'52e44704-48d0-49b6-81cf-416d8fa87be3',
	'52529bdd-ab6e-42b7-9e1e-10cf682664ef',
	'fbfcb2e2-c602-486e-91bf-0b9596dd0ac8',
	'960a9151-2381-4dbc-9667-76b292a7a606',
	'ac4b7653-98f3-4c4d-9c6d-3ad53ee3cffa',
	'52a0ea9a-22e4-4b28-9f94-312d9e27f32a',
	'9ef638a5-16cd-4b3d-8678-7338d27b6095',
	'abd4230f-7a43-4d8b-a66d-e667d37ea3c5',
	'f63a84a2-2029-4154-8126-317d0654a515',
	'7fe30312-b131-4da3-81d5-23c0d52d2f3f'
)
	AND `mask_blob_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `_cleanup_0013_blobs` (`id`)
SELECT `display_mask_blob_id`
FROM `edit_jobs`
WHERE `id` IN (
	'52e44704-48d0-49b6-81cf-416d8fa87be3',
	'52529bdd-ab6e-42b7-9e1e-10cf682664ef',
	'fbfcb2e2-c602-486e-91bf-0b9596dd0ac8',
	'960a9151-2381-4dbc-9667-76b292a7a606',
	'ac4b7653-98f3-4c4d-9c6d-3ad53ee3cffa',
	'52a0ea9a-22e4-4b28-9f94-312d9e27f32a',
	'9ef638a5-16cd-4b3d-8678-7338d27b6095',
	'abd4230f-7a43-4d8b-a66d-e667d37ea3c5',
	'f63a84a2-2029-4154-8126-317d0654a515',
	'7fe30312-b131-4da3-81d5-23c0d52d2f3f'
)
	AND `display_mask_blob_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `_cleanup_0013_blobs` (`id`)
SELECT `reference_blob_id`
FROM `edit_jobs`
WHERE `id` IN (
	'52e44704-48d0-49b6-81cf-416d8fa87be3',
	'52529bdd-ab6e-42b7-9e1e-10cf682664ef',
	'fbfcb2e2-c602-486e-91bf-0b9596dd0ac8',
	'960a9151-2381-4dbc-9667-76b292a7a606',
	'ac4b7653-98f3-4c4d-9c6d-3ad53ee3cffa',
	'52a0ea9a-22e4-4b28-9f94-312d9e27f32a',
	'9ef638a5-16cd-4b3d-8678-7338d27b6095',
	'abd4230f-7a43-4d8b-a66d-e667d37ea3c5',
	'f63a84a2-2029-4154-8126-317d0654a515',
	'7fe30312-b131-4da3-81d5-23c0d52d2f3f'
)
	AND `reference_blob_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `_cleanup_0013_blobs` (`id`)
SELECT `patch_blob_id`
FROM `revision_patches`
WHERE `revision_id` IN (
	'ee06571d-e36b-4443-bf6a-ec150d65fee0',
	'ec0166ea-26b2-4565-959b-454e68ccb29b',
	'6dd5039b-416e-419f-87e8-7a21b1bb0426',
	'5068a183-cb54-4e38-996b-ea3b1179f32c'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `_cleanup_0013_blobs` (`id`)
SELECT `display_mask_blob_id`
FROM `revision_patches`
WHERE `revision_id` IN (
	'ee06571d-e36b-4443-bf6a-ec150d65fee0',
	'ec0166ea-26b2-4565-959b-454e68ccb29b',
	'6dd5039b-416e-419f-87e8-7a21b1bb0426',
	'5068a183-cb54-4e38-996b-ea3b1179f32c'
)
	AND `display_mask_blob_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `_cleanup_0013_blobs` (`id`)
SELECT `blob_id`
FROM `keyframe_tiles`
WHERE `keyframe_id` IN (
	SELECT `id`
	FROM `keyframes`
	WHERE `revision_id` IN (
		'ee06571d-e36b-4443-bf6a-ec150d65fee0',
		'ec0166ea-26b2-4565-959b-454e68ccb29b',
		'6dd5039b-416e-419f-87e8-7a21b1bb0426',
		'5068a183-cb54-4e38-996b-ea3b1179f32c'
	)
);
--> statement-breakpoint
UPDATE `artworks`
SET `head_revision_id` = 'fe142165-05bf-4eec-acf1-5d7ddad605be',
	`head_sequence` = 2
WHERE `id` = 'palimpsest-purple';
--> statement-breakpoint
UPDATE `visitor_events`
SET `job_id` = NULL
WHERE `job_id` IN (
	'52e44704-48d0-49b6-81cf-416d8fa87be3',
	'52529bdd-ab6e-42b7-9e1e-10cf682664ef',
	'fbfcb2e2-c602-486e-91bf-0b9596dd0ac8',
	'960a9151-2381-4dbc-9667-76b292a7a606',
	'ac4b7653-98f3-4c4d-9c6d-3ad53ee3cffa',
	'52a0ea9a-22e4-4b28-9f94-312d9e27f32a',
	'9ef638a5-16cd-4b3d-8678-7338d27b6095',
	'abd4230f-7a43-4d8b-a66d-e667d37ea3c5',
	'f63a84a2-2029-4154-8126-317d0654a515',
	'7fe30312-b131-4da3-81d5-23c0d52d2f3f'
);
--> statement-breakpoint
DELETE FROM `rate_limit_claims`
WHERE `job_id` IN (
	'52e44704-48d0-49b6-81cf-416d8fa87be3',
	'52529bdd-ab6e-42b7-9e1e-10cf682664ef',
	'fbfcb2e2-c602-486e-91bf-0b9596dd0ac8',
	'960a9151-2381-4dbc-9667-76b292a7a606',
	'ac4b7653-98f3-4c4d-9c6d-3ad53ee3cffa',
	'52a0ea9a-22e4-4b28-9f94-312d9e27f32a',
	'9ef638a5-16cd-4b3d-8678-7338d27b6095',
	'abd4230f-7a43-4d8b-a66d-e667d37ea3c5',
	'f63a84a2-2029-4154-8126-317d0654a515',
	'7fe30312-b131-4da3-81d5-23c0d52d2f3f'
);
--> statement-breakpoint
UPDATE `artwork_commit_locks`
SET `owner_token` = NULL,
	`job_id` = NULL,
	`acquired_at` = NULL,
	`lease_expires_at` = NULL
WHERE `artwork_id` = 'palimpsest-purple'
	AND `job_id` IN (
		'52e44704-48d0-49b6-81cf-416d8fa87be3',
		'52529bdd-ab6e-42b7-9e1e-10cf682664ef',
		'fbfcb2e2-c602-486e-91bf-0b9596dd0ac8',
		'960a9151-2381-4dbc-9667-76b292a7a606',
		'ac4b7653-98f3-4c4d-9c6d-3ad53ee3cffa',
		'52a0ea9a-22e4-4b28-9f94-312d9e27f32a',
		'9ef638a5-16cd-4b3d-8678-7338d27b6095',
		'abd4230f-7a43-4d8b-a66d-e667d37ea3c5',
		'f63a84a2-2029-4154-8126-317d0654a515',
		'7fe30312-b131-4da3-81d5-23c0d52d2f3f'
	);
--> statement-breakpoint
DELETE FROM `revision_patches`
WHERE `revision_id` IN (
	'ee06571d-e36b-4443-bf6a-ec150d65fee0',
	'ec0166ea-26b2-4565-959b-454e68ccb29b',
	'6dd5039b-416e-419f-87e8-7a21b1bb0426',
	'5068a183-cb54-4e38-996b-ea3b1179f32c'
);
--> statement-breakpoint
DELETE FROM `keyframe_tiles`
WHERE `keyframe_id` IN (
	SELECT `id`
	FROM `keyframes`
	WHERE `revision_id` IN (
		'ee06571d-e36b-4443-bf6a-ec150d65fee0',
		'ec0166ea-26b2-4565-959b-454e68ccb29b',
		'6dd5039b-416e-419f-87e8-7a21b1bb0426',
		'5068a183-cb54-4e38-996b-ea3b1179f32c'
	)
);
--> statement-breakpoint
DELETE FROM `keyframes`
WHERE `revision_id` IN (
	'ee06571d-e36b-4443-bf6a-ec150d65fee0',
	'ec0166ea-26b2-4565-959b-454e68ccb29b',
	'6dd5039b-416e-419f-87e8-7a21b1bb0426',
	'5068a183-cb54-4e38-996b-ea3b1179f32c'
);
--> statement-breakpoint
DELETE FROM `edit_jobs`
WHERE `id` IN (
	'52e44704-48d0-49b6-81cf-416d8fa87be3',
	'52529bdd-ab6e-42b7-9e1e-10cf682664ef',
	'fbfcb2e2-c602-486e-91bf-0b9596dd0ac8',
	'960a9151-2381-4dbc-9667-76b292a7a606',
	'ac4b7653-98f3-4c4d-9c6d-3ad53ee3cffa',
	'52a0ea9a-22e4-4b28-9f94-312d9e27f32a',
	'9ef638a5-16cd-4b3d-8678-7338d27b6095',
	'abd4230f-7a43-4d8b-a66d-e667d37ea3c5',
	'f63a84a2-2029-4154-8126-317d0654a515',
	'7fe30312-b131-4da3-81d5-23c0d52d2f3f'
);
--> statement-breakpoint
DROP TRIGGER `revisions_immutable_delete`;
--> statement-breakpoint
DELETE FROM `revisions`
WHERE `id` IN (
	'ee06571d-e36b-4443-bf6a-ec150d65fee0',
	'ec0166ea-26b2-4565-959b-454e68ccb29b',
	'6dd5039b-416e-419f-87e8-7a21b1bb0426',
	'5068a183-cb54-4e38-996b-ea3b1179f32c'
);
--> statement-breakpoint
CREATE TRIGGER `revisions_immutable_delete`
BEFORE DELETE ON `revisions`
BEGIN SELECT RAISE(ABORT, 'accepted revisions are immutable'); END;
--> statement-breakpoint
DELETE FROM `blobs`
WHERE `id` IN (SELECT `id` FROM `_cleanup_0013_blobs`)
	AND `id` NOT IN (
		SELECT `patch_blob_id` FROM `revision_patches`
		UNION
		SELECT `display_mask_blob_id` FROM `revision_patches`
			WHERE `display_mask_blob_id` IS NOT NULL
		UNION
		SELECT `blob_id` FROM `keyframe_tiles`
		UNION
		SELECT `source_blob_id` FROM `edit_jobs`
			WHERE `source_blob_id` IS NOT NULL
		UNION
		SELECT `mask_blob_id` FROM `edit_jobs`
			WHERE `mask_blob_id` IS NOT NULL
		UNION
		SELECT `display_mask_blob_id` FROM `edit_jobs`
			WHERE `display_mask_blob_id` IS NOT NULL
		UNION
		SELECT `reference_blob_id` FROM `edit_jobs`
			WHERE `reference_blob_id` IS NOT NULL
	);
--> statement-breakpoint
DELETE FROM `authors`
WHERE `id` NOT IN (SELECT `author_id` FROM `revisions`)
	AND `id` NOT IN (SELECT `author_id` FROM `edit_jobs`);
--> statement-breakpoint
DROP TABLE `_cleanup_0013_blobs`;
--> statement-breakpoint
DROP TABLE `_cleanup_0013_guard`;
