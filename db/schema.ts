import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const createdAt = integer("created_at")
  .notNull()
  .default(sql`(unixepoch() * 1000)`);

export const artworks = sqliteTable("artworks", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  tileWidth: integer("tile_width").notNull(),
  tileHeight: integer("tile_height").notNull(),
  columns: integer("columns").notNull(),
  rows: integer("rows").notNull(),
  headRevisionId: text("head_revision_id"),
  headSequence: integer("head_sequence").notNull().default(0),
  createdAt,
});

export const authors = sqliteTable("authors", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  source: text("source", { enum: ["visitor", "seed"] }).notNull(),
  createdAt,
});

export const blobs = sqliteTable(
  "blobs",
  {
    id: text("id").primaryKey(),
    artworkId: text("artwork_id")
      .notNull()
      .references(() => artworks.id),
    kind: text("kind", {
      enum: [
        "canonical",
        "keyframe",
        "patch",
        "mask",
        "display_mask",
        "input",
      ],
    }).notNull(),
    r2Key: text("r2_key").notNull().unique(),
    contentType: text("content_type").notNull(),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt,
  },
  (table) => [index("blobs_artwork_kind_idx").on(table.artworkId, table.kind)],
);

export const revisions = sqliteTable(
  "revisions",
  {
    id: text("id").primaryKey(),
    artworkId: text("artwork_id")
      .notNull()
      .references(() => artworks.id),
    sequence: integer("sequence").notNull(),
    parentRevisionId: text("parent_revision_id"),
    jobId: text("job_id").unique(),
    origin: text("origin", {
      enum: ["seed", "demo", "openai", "revert"],
    }).notNull(),
    status: text("status", { enum: ["accepted"] }).notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => authors.id),
    prompt: text("prompt").notNull(),
    regionX: integer("region_x"),
    regionY: integer("region_y"),
    regionWidth: integer("region_width"),
    regionHeight: integer("region_height"),
    tileX: integer("tile_x"),
    tileY: integer("tile_y"),
    revertTargetRevisionId: text("revert_target_revision_id"),
    createdAt,
  },
  (table) => [
    uniqueIndex("revisions_artwork_sequence_uq").on(
      table.artworkId,
      table.sequence,
    ),
    index("revisions_artwork_created_idx").on(
      table.artworkId,
      table.createdAt,
    ),
  ],
);

export const keyframes = sqliteTable(
  "keyframes",
  {
    id: text("id").primaryKey(),
    artworkId: text("artwork_id")
      .notNull()
      .references(() => artworks.id),
    revisionId: text("revision_id")
      .notNull()
      .references(() => revisions.id),
    sequence: integer("sequence").notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex("keyframes_artwork_sequence_uq").on(
      table.artworkId,
      table.sequence,
    ),
  ],
);

export const keyframeTiles = sqliteTable(
  "keyframe_tiles",
  {
    keyframeId: text("keyframe_id")
      .notNull()
      .references(() => keyframes.id),
    tileX: integer("tile_x").notNull(),
    tileY: integer("tile_y").notNull(),
    blobId: text("blob_id")
      .notNull()
      .references(() => blobs.id),
  },
  (table) => [primaryKey({ columns: [table.keyframeId, table.tileX, table.tileY] })],
);

export const revisionPatches = sqliteTable(
  "revision_patches",
  {
    revisionId: text("revision_id")
      .notNull()
      .references(() => revisions.id),
    tileX: integer("tile_x").notNull(),
    tileY: integer("tile_y").notNull(),
    patchBlobId: text("patch_blob_id")
      .notNull()
      .references(() => blobs.id),
    displayMaskBlobId: text("display_mask_blob_id").references(() => blobs.id),
  },
  (table) => [primaryKey({ columns: [table.revisionId, table.tileX, table.tileY] })],
);

export const editJobs = sqliteTable(
  "edit_jobs",
  {
    id: text("id").primaryKey(),
    artworkId: text("artwork_id")
      .notNull()
      .references(() => artworks.id),
    kind: text("kind", { enum: ["edit", "revert"] }).notNull(),
    state: text("state", {
      enum: [
        "queued",
        "moderating",
        "generating",
        "committing",
        "succeeded",
        "stale",
        "rejected",
        "failed",
      ],
    }).notNull(),
    executionMode: text("execution_mode", {
      enum: ["demo", "openai", "none"],
    }).notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => authors.id),
    requesterHash: text("requester_hash").notNull(),
    baseRevisionId: text("base_revision_id").notNull(),
    targetRevisionId: text("target_revision_id"),
    prompt: text("prompt").notNull(),
    tileX: integer("tile_x"),
    tileY: integer("tile_y"),
    regionX: integer("region_x"),
    regionY: integer("region_y"),
    regionWidth: integer("region_width"),
    regionHeight: integer("region_height"),
    sourceBlobId: text("source_blob_id"),
    maskBlobId: text("mask_blob_id"),
    displayMaskBlobId: text("display_mask_blob_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: integer("available_at").notNull(),
    workerToken: text("worker_token"),
    lockFence: integer("lock_fence"),
    leaseExpiresAt: integer("lease_expires_at"),
    resultRevisionId: text("result_revision_id"),
    openaiRequestId: text("openai_request_id"),
    errorCode: text("error_code"),
    publicErrorMessage: text("public_error_message"),
    createdAt,
    updatedAt: integer("updated_at").notNull(),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
  },
  (table) => [
    uniqueIndex("edit_jobs_artwork_idempotency_uq").on(
      table.artworkId,
      table.idempotencyKey,
    ),
    index("edit_jobs_queue_idx").on(
      table.artworkId,
      table.state,
      table.availableAt,
      table.createdAt,
      table.id,
    ),
    index("edit_jobs_requester_idx").on(table.requesterHash, table.state),
  ],
);

export const queueLocks = sqliteTable("queue_locks", {
  artworkId: text("artwork_id")
    .primaryKey()
    .references(() => artworks.id),
  state: text("state", { enum: ["idle", "held"] }).notNull(),
  ownerToken: text("owner_token"),
  fence: integer("fence").notNull().default(0),
  jobId: text("job_id"),
  acquiredAt: integer("acquired_at"),
  heartbeatAt: integer("heartbeat_at"),
  leaseExpiresAt: integer("lease_expires_at"),
});

export const rateWindows = sqliteTable(
  "rate_windows",
  {
    requesterHash: text("requester_hash").notNull(),
    scope: text("scope").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.requesterHash, table.scope, table.windowStart],
    }),
  ],
);
