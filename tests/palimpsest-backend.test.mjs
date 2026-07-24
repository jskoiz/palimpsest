import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { serializeRecentJobPayload } from "../lib/palimpsest/activity.mjs";
import {
  isRetryableD1Reset,
  retryIdempotentD1,
} from "../lib/palimpsest/d1.mjs";

const root = new URL("../", import.meta.url);

async function readSqlConstant(relativePath, name) {
  const source = await readFile(new URL(relativePath, root), "utf8");
  const prefix = `export const ${name} = \``;
  const start = source.indexOf(prefix);
  assert.notEqual(start, -1, `${name} must be exported from ${relativePath}`);
  const sqlStart = start + prefix.length;
  const end = source.indexOf("`;", sqlStart);
  assert.notEqual(end, -1, `${name} must be a plain SQL template`);
  const sql = source.slice(sqlStart, end);
  assert.doesNotMatch(sql, /\$\{/u, `${name} must not interpolate untested SQL`);
  return sql;
}

function applyMigration(db, sql) {
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) db.exec(trimmed);
  }
}

async function migratedDatabase({ durable = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const [
    initial,
    parallel,
    liveOnly,
    whiteCanvasReset,
    referenceImages,
    durableJobs,
    visitorEvents,
  ] = await Promise.all([
    readFile(new URL("drizzle/0000_slow_gambit.sql", root), "utf8"),
    readFile(new URL("drizzle/0001_parallel_regions.sql", root), "utf8"),
    readFile(new URL("drizzle/0002_live_ai_only.sql", root), "utf8"),
    readFile(new URL("drizzle/0003_white_canvas_reset.sql", root), "utf8"),
    readFile(new URL("drizzle/0004_reference_images.sql", root), "utf8"),
    readFile(new URL("drizzle/0009_durable_job_attempts.sql", root), "utf8"),
    readFile(new URL("drizzle/0012_visitor_activity.sql", root), "utf8"),
  ]);
  applyMigration(db, initial);
  applyMigration(db, parallel);
  applyMigration(db, liveOnly);
  applyMigration(db, whiteCanvasReset);
  applyMigration(db, referenceImages);
  if (durable) {
    applyMigration(db, durableJobs);
    applyMigration(db, visitorEvents);
  }
  return db;
}

function seedArtwork(db) {
  db.exec(`
    INSERT INTO artworks (
      id, slug, title, width, height, tile_width, tile_height,
      columns, rows, head_revision_id, head_sequence, created_at
    ) VALUES ('palimpsest', 'palimpsest', 'Palimpsest', 2048, 2048, 1024, 1024,
      2, 2, 'r0', 0, 1);
    INSERT INTO authors (id, display_name, source, created_at) VALUES
      ('author-a', 'Author A', 'visitor', 1),
      ('author-b', 'Author B', 'visitor', 1),
      ('author-c', 'Author C', 'visitor', 1),
      ('archive', 'Archive', 'seed', 1);
    INSERT INTO revisions (
      id, artwork_id, sequence, parent_revision_id, origin, status,
      author_id, prompt, created_at
    ) VALUES ('r0', 'palimpsest', 0, NULL, 'seed', 'accepted', 'archive', 'Seed', 1);
    INSERT INTO artwork_commit_locks (artwork_id, fence) VALUES ('palimpsest', 0);
  `);
}

function reservationValues({
  jobId,
  authorId,
  region,
  now,
  baseRevisionId = "r0",
  requesterHash = "shared-nat",
  referenceBlobId = null,
}) {
  return [
    jobId,
    "palimpsest",
    "openai",
    authorId,
    requesterHash,
    baseRevisionId,
    `Prompt ${jobId}`,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    1024,
    1024,
    `source-${jobId}`,
    `mask-${jobId}`,
    `display-${jobId}`,
    referenceBlobId,
    `idem-${jobId}`,
    `fingerprint-${jobId}`,
    now,
    now + 60_000,
    now,
    `retry-token-hash-${jobId}`,
    `request-${jobId}`,
    0,
    0,
    3,
    0,
    12,
  ];
}

test("reference image migration adds an optional private input pointer", async () => {
  const db = await migratedDatabase();
  const columns = db.prepare("PRAGMA table_info(edit_jobs)").all();
  assert.equal(columns.some((column) => column.name === "reference_blob_id"), true);
  db.close();
});

test("D1 storage resets retry with exponential jitter but ordinary failures do not", async () => {
  let attempts = 0;
  const delays = [];
  const value = await retryIdempotentD1(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("outer", {
          cause: new Error("D1 DB storage operation exceeded timeout which caused object to be reset"),
        });
      }
      return "accepted-once";
    },
    {
      attempts: 3,
      random: () => 0,
      sleep: async (delay) => delays.push(delay),
    },
  );
  assert.equal(value, "accepted-once");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [150, 300]);
  assert.equal(isRetryableD1Reset(new Error("storage caused object to be reset")), true);

  let ordinaryAttempts = 0;
  await assert.rejects(
    retryIdempotentD1(async () => {
      ordinaryAttempts += 1;
      throw new Error("constraint failed");
    }),
    /constraint failed/u,
  );
  assert.equal(ordinaryAttempts, 1);
});

test("activity job serializer preserves the public durable-attempt contract", () => {
  const payload = serializeRecentJobPayload({
    jobId: "failed-1",
    kind: "edit",
    author: "Visitor",
    state: "failed",
    prompt: "private rejected prompt",
    regionX: 10,
    regionY: 20,
    regionWidth: 30,
    regionHeight: 40,
    reservationActive: 0,
    errorCode: "PROVIDER_TEMPORARY",
    publicErrorMessage: "Try again.",
    requestId: "request-1",
    createdAt: 1_000,
    updatedAt: 2_000,
    startedAt: 1_500,
    completedAt: 2_000,
    retryable: 1,
  });
  assert.deepEqual(payload, {
    id: "failed-1",
    kind: "edit",
    author: "Visitor",
    state: "failed",
    region: { x: 10, y: 20, width: 30, height: 40 },
    reservationActive: false,
    prompt: null,
    displaySummary: "region 10,20 · 30×40",
    error: { code: "PROVIDER_TEMPORARY", message: "Try again." },
    requestId: "request-1",
    submittedAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    startedAt: new Date(1_500).toISOString(),
    completedAt: new Date(2_000).toISOString(),
    retryable: true,
  });
});

test("visitor event migration stores pseudonymous activity without raw IP fields", async () => {
  const db = await migratedDatabase();
  const columns = db.prepare("PRAGMA table_info(visitor_events)").all();
  assert.deepEqual(
    columns.map((column) => column.name),
    [
      "id",
      "visitor_hash",
      "session_id",
      "event_type",
      "path",
      "country",
      "user_agent",
      "job_id",
      "created_at",
    ],
  );
  const foreignKeys = db.prepare("PRAGMA foreign_key_list(visitor_events)").all();
  assert.equal(
    foreignKeys.some((foreignKey) => foreignKey.from === "job_id" && foreignKey.on_delete === "SET NULL"),
    true,
  );
  db.prepare(
    `INSERT INTO visitor_events
     (id, visitor_hash, session_id, event_type, path, country, user_agent, created_at)
     VALUES ('event-1', 'salted-network-hash', 'opaque-session', 'page_view', '/', 'US', 'Test Browser', 1)`,
  ).run();
  const event = db.prepare("SELECT visitor_hash AS visitorHash, event_type AS eventType FROM visitor_events").get();
  assert.equal(event.visitorHash, "salted-network-hash");
  assert.equal(event.eventType, "page_view");
  db.close();
});

test("activity keeps expired nonterminal regions visible for recovery", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertSql, activeRegionsSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant("lib/palimpsest/store.ts", "ACTIVE_REGIONS_SQL"),
  ]);
  const insert = db.prepare(insertSql);
  insert.run(...reservationValues({
    jobId: "expired-visible",
    authorId: "author-a",
    region: { x: 0, y: 0, width: 100, height: 100 },
    now: 1_000,
  }));
  insert.run(...reservationValues({
    jobId: "active-visible",
    authorId: "author-b",
    region: { x: 300, y: 300, width: 100, height: 100 },
    now: 100_000,
  }));

  const rows = db.prepare(activeRegionsSql).all(120_000, "palimpsest");
  assert.deepEqual(
    rows.map((row) => ({ jobId: row.jobId, reservationActive: row.reservationActive })),
    [
      { jobId: "expired-visible", reservationActive: 0 },
      { jobId: "active-visible", reservationActive: 1 },
    ],
  );
  db.close();
});

function insertCommittingJob(db, {
  id,
  region,
  now,
  baseRevisionId = "r0",
  executionMode = "openai",
  referenceBlobId = null,
  token = `worker-${id}`,
  fence = 1,
}) {
  db.prepare(`
    INSERT INTO edit_jobs (
      id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
      base_revision_id, prompt, region_x, region_y, region_width, region_height,
      frame_x, frame_y, frame_width, frame_height, display_mask_blob_id,
      reference_blob_id,
      idempotency_key, request_fingerprint, available_at, worker_token,
      lease_fence, lease_expires_at, created_at, updated_at
    ) VALUES (?, 'palimpsest', 'edit', 'committing', ?, 'author-a', 'shared-nat',
      ?, 'Commit patch', ?, ?, ?, ?, 0, 0, 1024, 1024, 'display-mask',
      ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    executionMode,
    baseRevisionId,
    region.x,
    region.y,
    region.width,
    region.height,
    referenceBlobId,
    `idem-${id}`,
    `fingerprint-${id}`,
    now,
    token,
    fence,
    now + 60_000,
    now,
    now,
  );
  db.prepare(`
    UPDATE artwork_commit_locks
    SET owner_token = ?, fence = ?, job_id = ?, acquired_at = ?, lease_expires_at = ?
    WHERE artwork_id = 'palimpsest'
  `).run(`commit-${id}`, fence, id, now, now + 60_000);
  return { token, fence, commitToken: `commit-${id}` };
}

test("migration converts tile-local data and releases obsolete queue leases", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const initial = await readFile(
    new URL("drizzle/0000_slow_gambit.sql", root),
    "utf8",
  );
  applyMigration(db, initial);
  db.exec(`
    INSERT INTO artworks (
      id, slug, title, width, height, tile_width, tile_height,
      columns, rows, head_revision_id, head_sequence, created_at
    ) VALUES ('palimpsest', 'palimpsest', 'Palimpsest', 2048, 2048, 1024, 1024,
      2, 2, 'r2', 2, 1);
    INSERT INTO authors (id, display_name, source, created_at) VALUES
      ('archive', 'Archive', 'seed', 1),
      ('visitor', 'Visitor', 'visitor', 1);
    INSERT INTO blobs (
      id, artwork_id, kind, r2_key, content_type, byte_length,
      sha256, width, height, created_at
    ) VALUES ('patch', 'palimpsest', 'patch', 'patch.svg', 'image/svg+xml', 10,
      'hash', 1024, 1024, 1);
    INSERT INTO revisions (
      id, artwork_id, sequence, parent_revision_id, origin, status,
      author_id, prompt, region_x, region_y, region_width, region_height,
      tile_x, tile_y, created_at
    ) VALUES
      ('r0', 'palimpsest', 0, NULL, 'seed', 'accepted', 'archive', 'Seed',
        NULL, NULL, NULL, NULL, NULL, NULL, 1),
      ('r1', 'palimpsest', 1, 'r0', 'demo', 'accepted', 'visitor', 'Patch',
        12, 24, 100, 120, 1, 0, 2),
      ('r2', 'palimpsest', 2, 'r1', 'revert', 'accepted', 'visitor', 'Restore',
        NULL, NULL, NULL, NULL, 1, 1, 3);
    INSERT INTO revision_patches (
      revision_id, tile_x, tile_y, patch_blob_id, display_mask_blob_id
    ) VALUES ('r1', 1, 0, 'patch', NULL);
    INSERT INTO edit_jobs (
      id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
      base_revision_id, prompt, tile_x, tile_y,
      region_x, region_y, region_width, region_height,
      idempotency_key, request_fingerprint, available_at, worker_token,
      lock_fence, lease_expires_at, created_at, updated_at
    ) VALUES ('legacy-job', 'palimpsest', 'edit', 'generating', 'demo', 'visitor',
      'shared', 'r2', 'Legacy', 0, 1, 20, 30, 64, 80,
      'legacy-idem', 'legacy-fingerprint', 2, 'old-worker', 7, 999999, 2, 3);
    INSERT INTO queue_locks (
      artwork_id, state, owner_token, fence, job_id, acquired_at, heartbeat_at,
      lease_expires_at
    ) VALUES ('palimpsest', 'held', 'old-owner', 9, 'legacy-job', 2, 2, 999999);
  `);

  const parallel = await readFile(
    new URL("drizzle/0001_parallel_regions.sql", root),
    "utf8",
  );
  applyMigration(db, parallel);

  const revision = db.prepare(
    "SELECT region_x, region_y FROM revisions WHERE id = 'r1'",
  ).get();
  assert.deepEqual({ ...revision }, { region_x: 1036, region_y: 24 });
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT region_x, region_y, region_width, region_height FROM revisions WHERE id = 'r2'",
      ).get(),
    },
    { region_x: 0, region_y: 0, region_width: 2048, region_height: 2048 },
  );
  const patch = db.prepare(
    "SELECT frame_x, frame_y, frame_width, frame_height FROM revision_patches WHERE revision_id = 'r1'",
  ).get();
  assert.deepEqual({ ...patch }, {
    frame_x: 1024,
    frame_y: 0,
    frame_width: 1024,
    frame_height: 1024,
  });
  const job = db.prepare(`
    SELECT state, region_x, region_y, frame_x, frame_y, lease_fence,
           lease_expires_at, error_code
    FROM edit_jobs WHERE id = 'legacy-job'
  `).get();
  assert.deepEqual({ ...job }, {
    state: "failed",
    region_x: 20,
    region_y: 1054,
    frame_x: 0,
    frame_y: 1024,
    lease_fence: 7,
    lease_expires_at: null,
    error_code: "QUEUE_SCHEMA_UPGRADED",
  });
  const lock = db.prepare(
    "SELECT owner_token, fence, job_id, lease_expires_at FROM artwork_commit_locks",
  ).get();
  assert.deepEqual({ ...lock }, {
    owner_token: null,
    fence: 9,
    job_id: null,
    lease_expires_at: null,
  });

  const revisionColumns = db.prepare("PRAGMA table_info(revisions)").all();
  assert.equal(revisionColumns.some((column) => column.name === "tile_x"), false);
  const patchColumns = db.prepare("PRAGMA table_info(revision_patches)").all();
  assert.equal(patchColumns.some((column) => column.name === "frame_x"), true);
  assert.throws(() => db.exec("UPDATE revisions SET prompt = 'mutated' WHERE id = 'r1'"));
  db.close();
});

test("live-only migration retires non-live work without rewriting history", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const [initial, parallel, liveOnly] = await Promise.all([
    readFile(new URL("drizzle/0000_slow_gambit.sql", root), "utf8"),
    readFile(new URL("drizzle/0001_parallel_regions.sql", root), "utf8"),
    readFile(new URL("drizzle/0002_live_ai_only.sql", root), "utf8"),
  ]);
  applyMigration(db, initial);
  applyMigration(db, parallel);
  seedArtwork(db);
  db.exec(`
    INSERT INTO revisions (
      id, artwork_id, sequence, parent_revision_id, origin, status,
      author_id, prompt, created_at
    ) VALUES ('historical-demo', 'palimpsest', 1, 'r0', 'demo', 'accepted',
      'author-a', 'Historical demo revision', 2);
    INSERT INTO edit_jobs (
      id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
      base_revision_id, prompt, region_x, region_y, region_width, region_height,
      idempotency_key, request_fingerprint, available_at, worker_token,
      lease_expires_at, created_at, updated_at
    ) VALUES
      ('retired-demo', 'palimpsest', 'edit', 'generating', 'demo', 'author-a',
        'shared', 'r0', 'Retired demo', 0, 0, 100, 100, 'idem-demo',
        'fingerprint-demo', 10, 'demo-worker', 60000, 10, 10),
      ('live-openai', 'palimpsest', 'edit', 'queued', 'openai', 'author-b',
        'shared', 'r0', 'Live edit', 300, 300, 100, 100, 'idem-live',
        'fingerprint-live', 10, NULL, 60000, 10, 10);
  `);

  applyMigration(db, liveOnly);

  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT state, error_code, worker_token, lease_expires_at FROM edit_jobs WHERE id = 'retired-demo'",
      ).get(),
    },
    {
      state: "failed",
      error_code: "NON_LIVE_MODE_REMOVED",
      worker_token: null,
      lease_expires_at: null,
    },
  );
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT state, execution_mode FROM edit_jobs WHERE id = 'live-openai'",
      ).get(),
    },
    { state: "queued", execution_mode: "openai" },
  );
  assert.equal(
    db.prepare("SELECT origin FROM revisions WHERE id = 'historical-demo'").get().origin,
    "demo",
  );
  db.close();
});

test("white-canvas migration clears the prior archive and every reservation", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const [initial, parallel, liveOnly, whiteCanvasReset] = await Promise.all([
    readFile(new URL("drizzle/0000_slow_gambit.sql", root), "utf8"),
    readFile(new URL("drizzle/0001_parallel_regions.sql", root), "utf8"),
    readFile(new URL("drizzle/0002_live_ai_only.sql", root), "utf8"),
    readFile(new URL("drizzle/0003_white_canvas_reset.sql", root), "utf8"),
  ]);
  applyMigration(db, initial);
  applyMigration(db, parallel);
  applyMigration(db, liveOnly);
  seedArtwork(db);
  db.exec(`
    INSERT INTO blobs (
      id, artwork_id, kind, r2_key, content_type, byte_length,
      sha256, width, height, created_at
    ) VALUES
      ('old-keyframe', 'palimpsest', 'keyframe', 'old-keyframe.png', 'image/png',
        1, 'old-keyframe-hash', 1024, 1024, 1),
      ('old-patch', 'palimpsest', 'patch', 'old-patch.png', 'image/png',
        1, 'old-patch-hash', 1024, 1024, 1);
    INSERT INTO keyframes (id, artwork_id, revision_id, sequence, created_at)
      VALUES ('old-frame', 'palimpsest', 'r0', 0, 1);
    INSERT INTO keyframe_tiles (keyframe_id, tile_x, tile_y, blob_id)
      VALUES ('old-frame', 0, 0, 'old-keyframe');
    INSERT INTO revisions (
      id, artwork_id, sequence, parent_revision_id, origin, status,
      author_id, prompt, region_x, region_y, region_width, region_height, created_at
    ) VALUES ('old-revision', 'palimpsest', 1, 'r0', 'openai', 'accepted',
      'author-a', 'Old edit', 0, 0, 128, 128, 2);
    INSERT INTO revision_patches (
      revision_id, patch_blob_id, display_mask_blob_id,
      frame_x, frame_y, frame_width, frame_height
    ) VALUES ('old-revision', 'old-patch', NULL, 0, 0, 1024, 1024);
    INSERT INTO edit_jobs (
      id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
      base_revision_id, prompt, region_x, region_y, region_width, region_height,
      idempotency_key, request_fingerprint, available_at, lease_expires_at,
      created_at, updated_at
    ) VALUES ('active-edit', 'palimpsest', 'edit', 'generating', 'openai',
      'author-b', 'requester', 'r0', 'Active edit', 256, 256, 128, 128,
      'active-idem', 'active-fingerprint', 1, 999999, 1, 1);
    INSERT INTO rate_windows (
      requester_hash, scope, window_start, count, updated_at
    ) VALUES ('requester', 'edit', 0, 1, 1);
  `);

  applyMigration(db, whiteCanvasReset);

  for (const table of [
    "artworks",
    "authors",
    "blobs",
    "edit_jobs",
    "keyframe_tiles",
    "keyframes",
    "rate_windows",
    "revision_patches",
    "revisions",
    "artwork_commit_locks",
  ]) {
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
      0,
      `${table} must be empty after the reset`,
    );
  }

  seedArtwork(db);
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT head_revision_id, head_sequence FROM artworks WHERE id = 'palimpsest'",
      ).get(),
    },
    { head_revision_id: "r0", head_sequence: 0 },
  );
  assert.throws(() => db.exec("DELETE FROM revisions WHERE id = 'r0'"));
  db.close();
});

test("purple-canvas migration removes the current duck revision and reseeds cleanly", async () => {
  const db = await migratedDatabase({ durable: false });
  seedArtwork(db);
  db.exec(`
    INSERT INTO blobs (
      id, artwork_id, kind, r2_key, content_type, byte_length,
      sha256, width, height, created_at
    ) VALUES ('duck-patch', 'palimpsest', 'patch', 'duck.png', 'image/png',
      1, 'duck-hash', 1024, 1024, 2);
    INSERT INTO revisions (
      id, artwork_id, sequence, parent_revision_id, origin, status,
      author_id, prompt, region_x, region_y, region_width, region_height, created_at
    ) VALUES ('duck-revision', 'palimpsest', 1, 'r0', 'openai', 'accepted',
      'author-a', 'A large rubber duck', 512, 512, 1024, 1024, 2);
    INSERT INTO revision_patches (
      revision_id, patch_blob_id, display_mask_blob_id,
      frame_x, frame_y, frame_width, frame_height
    ) VALUES ('duck-revision', 'duck-patch', NULL, 512, 512, 1024, 1024);
    UPDATE artworks
    SET head_revision_id = 'duck-revision', head_sequence = 1
    WHERE id = 'palimpsest';
  `);

  const purpleCanvasReset = await readFile(
    new URL("drizzle/0005_purple_canvas_reset.sql", root),
    "utf8",
  );
  applyMigration(db, purpleCanvasReset);

  for (const table of [
    "artworks",
    "authors",
    "blobs",
    "edit_jobs",
    "keyframe_tiles",
    "keyframes",
    "rate_windows",
    "revision_patches",
    "revisions",
    "artwork_commit_locks",
  ]) {
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
      0,
      `${table} must be empty after the purple reset`,
    );
  }

  seedArtwork(db);
  assert.throws(() => db.exec("DELETE FROM revisions WHERE id = 'r0'"));
  db.close();
});

test("live-canvas reset targets the current archive with validated SQL", async () => {
  const [domainSource, purpleCanvasReset, liveCanvasReset] = await Promise.all([
    readFile(new URL("lib/palimpsest/domain.mjs", root), "utf8"),
    readFile(new URL("drizzle/0005_purple_canvas_reset.sql", root), "utf8"),
    readFile(new URL("drizzle/0008_clear_live_archive.sql", root), "utf8"),
  ]);
  const artworkId = domainSource.match(/ARTWORK_ID = "([^"]+)"/u)?.[1];

  assert.equal(artworkId, "palimpsest-purple");
  assert.match(liveCanvasReset, new RegExp(`'${artworkId}'`, "u"));
  assert.doesNotMatch(liveCanvasReset, /'palimpsest'/u);
  assert.equal(
    liveCanvasReset.replaceAll("'palimpsest-purple'", "'palimpsest'"),
    purpleCanvasReset,
  );
});

test("canvas-and-history reset clears the current archive and durable job state", async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO artworks (
      id, slug, title, width, height, tile_width, tile_height,
      columns, rows, head_revision_id, head_sequence, created_at
    ) VALUES ('palimpsest-purple', 'palimpsest', 'Palimpsest', 2048, 2048,
      1024, 1024, 2, 2, 'cropped-revision', 1, 1);
    INSERT INTO authors (id, display_name, source, created_at) VALUES
      ('archive-purple', 'Palimpsest Archive', 'seed', 1),
      ('visitor-purple', 'Visitor', 'visitor', 2);
    INSERT INTO blobs (
      id, artwork_id, kind, r2_key, content_type, byte_length,
      sha256, width, height, created_at
    ) VALUES ('cropped-patch', 'palimpsest-purple', 'patch', 'cropped.png',
      'image/png', 1, 'cropped-hash', 1024, 1024, 2);
    INSERT INTO revisions (
      id, artwork_id, sequence, parent_revision_id, origin, status,
      author_id, prompt, region_x, region_y, region_width, region_height, created_at
    ) VALUES
      ('purple-seed', 'palimpsest-purple', 0, NULL, 'seed', 'accepted',
        'archive-purple', 'Purple abstract canvas.', NULL, NULL, NULL, NULL, 1),
      ('cropped-revision', 'palimpsest-purple', 1, 'purple-seed', 'openai',
        'accepted', 'visitor-purple', 'Cropped note', 0, 1154, 326, 260, 2);
    INSERT INTO revision_patches (
      revision_id, patch_blob_id, display_mask_blob_id,
      frame_x, frame_y, frame_width, frame_height
    ) VALUES ('cropped-revision', 'cropped-patch', NULL, 0, 772, 1024, 1024);
    INSERT INTO edit_jobs (
      id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
      base_revision_id, prompt, region_x, region_y, region_width, region_height,
      idempotency_key, request_fingerprint, available_at, lease_expires_at,
      created_at, updated_at, retry_token_hash, request_id
    ) VALUES ('cropped-job', 'palimpsest-purple', 'edit', 'succeeded', 'openai',
      'visitor-purple', 'requester', 'purple-seed', 'Cropped note', 0, 1154, 326,
      260, 'cropped-idem', 'cropped-fingerprint', 1, NULL, 1, 2,
      'retry-token-hash', 'request-cropped');
    INSERT INTO artwork_commit_locks (artwork_id, fence)
      VALUES ('palimpsest-purple', 2);
    INSERT INTO rate_limit_claims (
      requester_hash, scope, window_start, idempotency_key, job_id, created_at
    ) VALUES ('requester', 'edit:short', 0, 'cropped-idem', 'cropped-job', 1);
  `);

  const reset = await readFile(
    new URL("drizzle/0011_clear_canvas_and_history.sql", root),
    "utf8",
  );
  applyMigration(db, reset);

  assert.match(reset, /'palimpsest-purple'/u);
  assert.doesNotMatch(reset, /'palimpsest'/u);
  for (const table of [
    "artworks",
    "authors",
    "blobs",
    "edit_jobs",
    "keyframe_tiles",
    "keyframes",
    "rate_limit_claims",
    "revision_patches",
    "revisions",
    "artwork_commit_locks",
  ]) {
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
      0,
      `${table} must be empty after the canvas-and-history reset`,
    );
  }

  db.exec(`
    INSERT INTO artworks (
      id, slug, title, width, height, tile_width, tile_height,
      columns, rows, head_revision_id, head_sequence, created_at
    ) VALUES ('palimpsest-purple', 'palimpsest', 'Palimpsest', 2048, 2048,
      1024, 1024, 2, 2, 'purple-seed', 0, 3);
    INSERT INTO authors (id, display_name, source, created_at)
      VALUES ('archive-purple', 'Palimpsest Archive', 'seed', 3);
    INSERT INTO revisions (
      id, artwork_id, sequence, parent_revision_id, origin, status,
      author_id, prompt, created_at
    ) VALUES ('purple-seed', 'palimpsest-purple', 0, NULL, 'seed', 'accepted',
      'archive-purple', 'Purple abstract canvas.', 3);
  `);
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT head_revision_id, head_sequence FROM artworks WHERE id = 'palimpsest-purple'",
      ).get(),
    },
    { head_revision_id: "purple-seed", head_sequence: 0 },
  );
  assert.throws(() => db.exec("DELETE FROM revisions WHERE id = 'purple-seed'"));
  db.close();
});

test("logo and mascot cleanup restores revision 2 without touching earlier work", async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO artworks (
      id, slug, title, width, height, tile_width, tile_height,
      columns, rows, head_revision_id, head_sequence, created_at
    ) VALUES ('palimpsest-purple', 'palimpsest', 'Palimpsest', 2048, 2048,
      1024, 1024, 2, 2, '5068a183-cb54-4e38-996b-ea3b1179f32c', 6, 1);
    INSERT INTO authors (id, display_name, source, created_at) VALUES
      ('archive-purple', 'Palimpsest Archive', 'seed', 1),
      ('visitor-purple', 'Visitor', 'visitor', 2),
      ('target-only-author', 'Target only', 'visitor', 3);
    INSERT INTO blobs (
      id, artwork_id, kind, r2_key, content_type, byte_length,
      sha256, width, height, created_at
    ) VALUES
      ('keep-source', 'palimpsest-purple', 'input', 'keep-source.png',
        'image/png', 1, 'keep-source-hash', 1024, 1024, 1),
      ('keep-patch', 'palimpsest-purple', 'patch', 'keep-patch.png',
        'image/png', 1, 'keep-patch-hash', 1024, 1024, 1),
      ('mascot-source', 'palimpsest-purple', 'input', 'mascot-source.png',
        'image/png', 1, 'mascot-source-hash', 1024, 1024, 2),
      ('mascot-patch', 'palimpsest-purple', 'patch', 'mascot-patch.png',
        'image/png', 1, 'mascot-patch-hash', 1024, 1024, 2),
      ('mascot-tile', 'palimpsest-purple', 'keyframe', 'mascot-tile.png',
        'image/png', 1, 'mascot-tile-hash', 1024, 1024, 2),
      ('placement-source', 'palimpsest-purple', 'input', 'placement-source.png',
        'image/png', 1, 'placement-source-hash', 1024, 1024, 3),
      ('placement-patch', 'palimpsest-purple', 'patch', 'placement-patch.png',
        'image/png', 1, 'placement-patch-hash', 1024, 1024, 3),
      ('logo-source', 'palimpsest-purple', 'input', 'logo-source.png',
        'image/png', 1, 'logo-source-hash', 1024, 1024, 4),
      ('logo-patch', 'palimpsest-purple', 'patch', 'logo-patch.png',
        'image/png', 1, 'logo-patch-hash', 1024, 1024, 4),
      ('failed-mask', 'palimpsest-purple', 'mask', 'failed-mask.png',
        'image/png', 1, 'failed-mask-hash', 1024, 1024, 5);
    INSERT INTO revisions (
      id, artwork_id, sequence, parent_revision_id, origin, status,
      author_id, prompt, revert_target_revision_id, created_at
    ) VALUES
      ('rev-seed-purple-000', 'palimpsest-purple', 0, NULL, 'seed', 'accepted',
        'archive-purple', 'Purple abstract canvas.', NULL, 1),
      ('63eac4d4-f2a9-454b-b347-5d8660e309a4', 'palimpsest-purple', 1,
        'rev-seed-purple-000', 'openai', 'accepted', 'visitor-purple',
        'Codex is awesome', NULL, 2),
      ('fe142165-05bf-4eec-acf1-5d7ddad605be', 'palimpsest-purple', 2,
        '63eac4d4-f2a9-454b-b347-5d8660e309a4', 'openai', 'accepted',
        'visitor-purple', 'a jalapeno', NULL, 3),
      ('ee06571d-e36b-4443-bf6a-ec150d65fee0', 'palimpsest-purple', 3,
        'fe142165-05bf-4eec-acf1-5d7ddad605be', 'openai', 'accepted',
        'visitor-purple', 'codex mascot', NULL, 4),
      ('ec0166ea-26b2-4565-959b-454e68ccb29b', 'palimpsest-purple', 4,
        'ee06571d-e36b-4443-bf6a-ec150d65fee0', 'revert', 'accepted',
        'archive-purple', 'Restore revision 2',
        'fe142165-05bf-4eec-acf1-5d7ddad605be', 5),
      ('6dd5039b-416e-419f-87e8-7a21b1bb0426', 'palimpsest-purple', 5,
        'ec0166ea-26b2-4565-959b-454e68ccb29b', 'placement', 'accepted',
        'visitor-purple', 'Codex mascot placement', NULL, 6),
      ('5068a183-cb54-4e38-996b-ea3b1179f32c', 'palimpsest-purple', 6,
        '6dd5039b-416e-419f-87e8-7a21b1bb0426', 'placement', 'accepted',
        'visitor-purple', 'openai logo', NULL, 7);
    INSERT INTO revision_patches (
      revision_id, patch_blob_id, display_mask_blob_id,
      frame_x, frame_y, frame_width, frame_height
    ) VALUES
      ('fe142165-05bf-4eec-acf1-5d7ddad605be', 'keep-patch', NULL,
        1024, 1024, 1024, 1024),
      ('ee06571d-e36b-4443-bf6a-ec150d65fee0', 'mascot-patch', NULL,
        0, 0, 1024, 1024),
      ('6dd5039b-416e-419f-87e8-7a21b1bb0426', 'placement-patch', NULL,
        0, 0, 1024, 1024),
      ('5068a183-cb54-4e38-996b-ea3b1179f32c', 'logo-patch', NULL,
        0, 0, 1024, 1024);
    INSERT INTO keyframes (id, artwork_id, revision_id, sequence, created_at)
      VALUES ('mascot-keyframe', 'palimpsest-purple',
        'ee06571d-e36b-4443-bf6a-ec150d65fee0', 3, 4);
    INSERT INTO keyframe_tiles (keyframe_id, tile_x, tile_y, blob_id)
      VALUES ('mascot-keyframe', 0, 0, 'mascot-tile');
  `);

  const insertJob = db.prepare(`
    INSERT INTO edit_jobs (
      id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
      base_revision_id, target_revision_id, prompt, source_blob_id, mask_blob_id,
      idempotency_key, request_fingerprint, available_at, result_revision_id,
      created_at, updated_at
    ) VALUES (?, 'palimpsest-purple', ?, ?, ?, ?, 'requester', ?, ?, ?, ?, ?,
      ?, ?, 1, ?, ?, ?)
  `);
  const addJob = ({
    id,
    kind = "edit",
    state = "succeeded",
    executionMode = "openai",
    authorId = "visitor-purple",
    baseRevisionId,
    targetRevisionId = null,
    prompt,
    sourceBlobId = null,
    maskBlobId = null,
    resultRevisionId = null,
    createdAt,
  }) => insertJob.run(
    id,
    kind,
    state,
    executionMode,
    authorId,
    baseRevisionId,
    targetRevisionId,
    prompt,
    sourceBlobId,
    maskBlobId,
    `idem-${id}`,
    `fingerprint-${id}`,
    resultRevisionId,
    createdAt,
    createdAt,
  );
  addJob({
    id: "keep-job",
    baseRevisionId: "63eac4d4-f2a9-454b-b347-5d8660e309a4",
    prompt: "a jalapeno",
    sourceBlobId: "keep-source",
    resultRevisionId: "fe142165-05bf-4eec-acf1-5d7ddad605be",
    createdAt: 3,
  });
  addJob({
    id: "52529bdd-ab6e-42b7-9e1e-10cf682664ef",
    baseRevisionId: "fe142165-05bf-4eec-acf1-5d7ddad605be",
    prompt: "codex mascot",
    sourceBlobId: "mascot-source",
    resultRevisionId: "ee06571d-e36b-4443-bf6a-ec150d65fee0",
    createdAt: 4,
  });
  addJob({
    id: "fbfcb2e2-c602-486e-91bf-0b9596dd0ac8",
    kind: "revert",
    executionMode: "none",
    authorId: "archive-purple",
    baseRevisionId: "ee06571d-e36b-4443-bf6a-ec150d65fee0",
    targetRevisionId: "fe142165-05bf-4eec-acf1-5d7ddad605be",
    prompt: "Restore revision 2",
    resultRevisionId: "ec0166ea-26b2-4565-959b-454e68ccb29b",
    createdAt: 5,
  });
  addJob({
    id: "abd4230f-7a43-4d8b-a66d-e667d37ea3c5",
    executionMode: "placement",
    baseRevisionId: "ec0166ea-26b2-4565-959b-454e68ccb29b",
    prompt: "Codex mascot placement",
    sourceBlobId: "placement-source",
    resultRevisionId: "6dd5039b-416e-419f-87e8-7a21b1bb0426",
    createdAt: 6,
  });
  addJob({
    id: "7fe30312-b131-4da3-81d5-23c0d52d2f3f",
    executionMode: "placement",
    baseRevisionId: "6dd5039b-416e-419f-87e8-7a21b1bb0426",
    prompt: "openai logo",
    sourceBlobId: "logo-source",
    resultRevisionId: "5068a183-cb54-4e38-996b-ea3b1179f32c",
    createdAt: 7,
  });
  addJob({
    id: "52e44704-48d0-49b6-81cf-416d8fa87be3",
    state: "failed",
    authorId: "target-only-author",
    baseRevisionId: "fe142165-05bf-4eec-acf1-5d7ddad605be",
    prompt: "failed mascot attempt",
    maskBlobId: "failed-mask",
    createdAt: 8,
  });

  db.exec(`
    INSERT INTO artwork_commit_locks (
      artwork_id, owner_token, fence, job_id, acquired_at, lease_expires_at
    ) VALUES ('palimpsest-purple', 'worker', 7,
      '7fe30312-b131-4da3-81d5-23c0d52d2f3f', 7, 9);
    INSERT INTO rate_limit_claims (
      requester_hash, scope, window_start, idempotency_key, job_id, created_at
    ) VALUES
      ('requester', 'edit:short', 0, 'keep', 'keep-job', 1),
      ('requester', 'edit:short', 1, 'logo',
        '7fe30312-b131-4da3-81d5-23c0d52d2f3f', 2);
    INSERT INTO visitor_events (
      id, visitor_hash, event_type, path, job_id, created_at
    ) VALUES
      ('keep-event', 'visitor', 'generation_requested', '/', 'keep-job', 1),
      ('logo-event', 'visitor', 'generation_requested', '/',
        '7fe30312-b131-4da3-81d5-23c0d52d2f3f', 2);
  `);

  const cleanup = await readFile(
    new URL("drizzle/0013_remove_logo_mascot_generations.sql", root),
    "utf8",
  );
  applyMigration(db, cleanup);

  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT head_revision_id, head_sequence FROM artworks WHERE id = 'palimpsest-purple'",
      ).get(),
    },
    {
      head_revision_id: "fe142165-05bf-4eec-acf1-5d7ddad605be",
      head_sequence: 2,
    },
  );
  assert.deepEqual(
    db.prepare(
      "SELECT id FROM revisions WHERE artwork_id = 'palimpsest-purple' ORDER BY sequence",
    ).all().map(({ id }) => id),
    [
      "rev-seed-purple-000",
      "63eac4d4-f2a9-454b-b347-5d8660e309a4",
      "fe142165-05bf-4eec-acf1-5d7ddad605be",
    ],
  );
  assert.deepEqual(
    db.prepare("SELECT id FROM edit_jobs ORDER BY id").all().map(({ id }) => id),
    ["keep-job"],
  );
  assert.deepEqual(
    db.prepare("SELECT id FROM blobs ORDER BY id").all().map(({ id }) => id),
    ["keep-patch", "keep-source"],
  );
  assert.deepEqual(
    db.prepare(
      "SELECT id, job_id FROM visitor_events ORDER BY id",
    ).all().map((row) => ({ ...row })),
    [
      { id: "keep-event", job_id: "keep-job" },
      { id: "logo-event", job_id: null },
    ],
  );
  assert.deepEqual(
    db.prepare("SELECT job_id FROM rate_limit_claims ORDER BY job_id").all()
      .map(({ job_id: jobId }) => jobId),
    ["keep-job"],
  );
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT owner_token, job_id, acquired_at, lease_expires_at FROM artwork_commit_locks",
      ).get(),
    },
    {
      owner_token: null,
      job_id: null,
      acquired_at: null,
      lease_expires_at: null,
    },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM authors WHERE id = 'target-only-author'").get().count,
    0,
  );
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '_cleanup_0013_%'",
    ).get().count,
    0,
  );
  assert.throws(() => db.exec(
    "DELETE FROM revisions WHERE id = 'fe142165-05bf-4eec-acf1-5d7ddad605be'",
  ));
  db.close();

  const diverged = await migratedDatabase();
  diverged.exec(`
    INSERT INTO artworks (
      id, slug, title, width, height, tile_width, tile_height,
      columns, rows, head_revision_id, head_sequence, created_at
    ) VALUES ('palimpsest-purple', 'palimpsest', 'Palimpsest', 2048, 2048,
      1024, 1024, 2, 2, 'future-revision', 7, 1);
  `);
  assert.throws(
    () => applyMigration(diverged, cleanup),
    /CHECK constraint failed/u,
  );
  assert.deepEqual(
    {
      ...diverged.prepare(
        "SELECT head_revision_id, head_sequence FROM artworks WHERE id = 'palimpsest-purple'",
      ).get(),
    },
    { head_revision_id: "future-revision", head_sequence: 7 },
  );
  diverged.close();
});

test("atomic spatial reservations reject overlap, allow touching, and expire cleanly", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const insertSql = await readSqlConstant(
    "lib/palimpsest/store.ts",
    "INSERT_EDIT_RESERVATION_SQL",
  );
  const now = 10_000;
  const insert = db.prepare(insertSql);

  assert.equal(
    insert.run(...reservationValues({
      jobId: "job-a",
      authorId: "author-a",
      region: { x: 0, y: 0, width: 100, height: 100 },
      now,
      referenceBlobId: "reference-job-a",
    })).changes,
    1,
  );
  assert.equal(
    db.prepare("SELECT reference_blob_id FROM edit_jobs WHERE id = 'job-a'").get()
      .reference_blob_id,
    "reference-job-a",
  );
  assert.equal(
    insert.run(...reservationValues({
      jobId: "job-overlap",
      authorId: "author-b",
      region: { x: 99, y: 0, width: 100, height: 100 },
      now: now + 1,
    })).changes,
    0,
  );
  assert.equal(
    insert.run(...reservationValues({
      jobId: "job-touch",
      authorId: "author-b",
      region: { x: 100, y: 0, width: 100, height: 100 },
      now: now + 1,
    })).changes,
    1,
  );

  db.exec("UPDATE edit_jobs SET lease_expires_at = 9999 WHERE id = 'job-a'");
  assert.equal(
    insert.run(...reservationValues({
      jobId: "job-after-expiry",
      authorId: "author-c",
      region: { x: 0, y: 0, width: 100, height: 100 },
      now: now + 2,
    })).changes,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM edit_jobs WHERE requester_hash = 'shared-nat'").get().count,
    3,
  );
  db.close();
});

test("reservation rate gates are atomic inputs and same-key replay stays singular", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const insertSql = await readSqlConstant(
    "lib/palimpsest/store.ts",
    "INSERT_EDIT_RESERVATION_SQL",
  );
  db.exec(`
    INSERT INTO rate_limit_claims
      (requester_hash, scope, window_start, idempotency_key, job_id, created_at)
    VALUES
      ('limited', 'edit-10m', 0, 'used-1', 'old-1', 1),
      ('limited', 'edit-10m', 0, 'used-2', 'old-2', 1),
      ('limited', 'edit-10m', 0, 'used-3', 'old-3', 1);
  `);
  const values = reservationValues({
    jobId: "rate-gated",
    authorId: "author-a",
    requesterHash: "limited",
    region: { x: 0, y: 0, width: 100, height: 100 },
    now: 10_000,
  });
  values[26] = 1;
  values[27] = 0;
  values[28] = 3;
  values[29] = 0;
  values[30] = 12;
  assert.equal(db.prepare(insertSql).run(...values).changes, 0);

  db.exec("DELETE FROM rate_limit_claims WHERE idempotency_key = 'used-3'");
  assert.equal(db.prepare(insertSql).run(...values).changes, 1);
  assert.equal(db.prepare(insertSql).run(...values).changes, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM edit_jobs WHERE idempotency_key = 'idem-rate-gated'").get().count,
    1,
  );
  db.close();
});

test("expired input preparation becomes terminal instead of remaining queued", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertSql, expireSql, releaseClaimsSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant(
      "lib/palimpsest/queue.ts",
      "EXPIRE_PREPARING_RESERVATION_SQL",
    ),
    readSqlConstant(
      "lib/palimpsest/queue.ts",
      "RELEASE_FAILED_PREPARATION_RATE_CLAIMS_SQL",
    ),
  ]);
  const now = 15_000;
  const values = reservationValues({
    jobId: "abandoned-preparation",
    authorId: "author-a",
    region: { x: 0, y: 0, width: 100, height: 100 },
    now,
  });
  values[21] = Number.MAX_SAFE_INTEGER;
  values[22] = now - 1;
  assert.equal(db.prepare(insertSql).run(...values).changes, 1);
  db.prepare(
    `INSERT INTO rate_limit_claims
     (requester_hash, scope, window_start, idempotency_key, job_id, created_at)
     VALUES ('shared-nat', 'edit-10m', 0, 'idem-abandoned-preparation',
             'abandoned-preparation', ?)`,
  ).run(now);

  assert.equal(
    db.prepare(expireSql).run(
      now,
      now,
      "palimpsest",
      Number.MAX_SAFE_INTEGER,
      now,
    ).changes,
    1,
  );
  assert.equal(db.prepare(releaseClaimsSql).run("palimpsest").changes, 1);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM rate_limit_claims WHERE job_id = 'abandoned-preparation'",
    ).get().count,
    0,
  );
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT state, error_code, lease_expires_at FROM edit_jobs WHERE id = 'abandoned-preparation'",
      ).get(),
    },
    {
      state: "failed",
      error_code: "QUEUE_PREPARATION_EXPIRED",
      lease_expires_at: null,
    },
  );
  db.close();
});

test("expired ready reservations become terminal and cannot be claimed", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertSql, claimSql, expireSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant("lib/palimpsest/queue.ts", "CLAIM_NEXT_JOB_SQL"),
    readSqlConstant(
      "lib/palimpsest/queue.ts",
      "EXPIRE_READY_QUEUE_RESERVATION_SQL",
    ),
  ]);
  const now = 18_000;
  const values = reservationValues({
    jobId: "expired-ready",
    authorId: "author-a",
    region: { x: 0, y: 0, width: 100, height: 100 },
    now,
  });
  values[22] = now - 1;
  assert.equal(db.prepare(insertSql).run(...values).changes, 1);

  assert.equal(
    db.prepare(claimSql).get(
      "worker-expired",
      now + 60_000,
      now,
      now,
      "palimpsest",
      now,
      now,
      now,
      now,
      now,
    ),
    undefined,
  );
  assert.equal(
    db.prepare(expireSql).run(
      now,
      now,
      "palimpsest",
      Number.MAX_SAFE_INTEGER,
      now,
    ).changes,
    1,
  );
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT state, error_code, lease_expires_at FROM edit_jobs WHERE id = 'expired-ready'",
      ).get(),
    },
    {
      state: "failed",
      error_code: "QUEUE_LEASE_EXPIRED",
      lease_expires_at: null,
    },
  );
  db.close();
});

test("expired active work is superseded by a newer overlapping reservation", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertSql, claimSql, supersedeSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant("lib/palimpsest/queue.ts", "CLAIM_NEXT_JOB_SQL"),
    readSqlConstant(
      "lib/palimpsest/queue.ts",
      "SUPERSEDE_EXPIRED_ACTIVE_RESERVATION_SQL",
    ),
  ]);
  const now = 19_000;
  const insert = db.prepare(insertSql);
  const expired = reservationValues({
    jobId: "expired-active",
    authorId: "author-a",
    region: { x: 0, y: 0, width: 100, height: 100 },
    now: now - 100,
  });
  expired[22] = now - 1;
  assert.equal(insert.run(...expired).changes, 1);
  db.prepare(
    `UPDATE edit_jobs
     SET state = 'generating', worker_token = 'worker-expired', lease_fence = 1
     WHERE id = 'expired-active'`,
  ).run();
  assert.equal(
    insert.run(...reservationValues({
      jobId: "newer-live",
      authorId: "author-b",
      region: { x: 50, y: 50, width: 100, height: 100 },
      now,
    })).changes,
    1,
  );

  assert.equal(
    db.prepare(supersedeSql).run(now, now, "palimpsest", now, now).changes,
    1,
  );
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT state, error_code, worker_token, lease_expires_at FROM edit_jobs WHERE id = 'expired-active'",
      ).get(),
    },
    {
      state: "failed",
      error_code: "QUEUE_RESERVATION_SUPERSEDED",
      worker_token: null,
      lease_expires_at: null,
    },
  );

  const claimed = db.prepare(claimSql).get(
    "worker-new",
    now + 60_000,
    now,
    now,
    "palimpsest",
    now,
    now,
    now,
    now,
    now,
  );
  assert.equal(claimed.id, "newer-live");
  db.close();
});

test("worker heartbeats renew only the current fenced lease", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertSql, renewSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant("lib/palimpsest/queue.ts", "RENEW_WORKER_LEASE_SQL"),
  ]);
  const now = 19_500;
  assert.equal(
    db.prepare(insertSql).run(...reservationValues({
      jobId: "heartbeat-worker",
      authorId: "author-a",
      region: { x: 0, y: 0, width: 100, height: 100 },
      now,
    })).changes,
    1,
  );
  db.prepare(
    `UPDATE edit_jobs
     SET state = 'generating', worker_token = 'worker-current',
         lease_fence = 3, started_at = ?
     WHERE id = 'heartbeat-worker'`,
  ).run(now);

  assert.equal(
    db.prepare(renewSql).run(
      now + 10_000,
      now + 70_000,
      "heartbeat-worker",
      "palimpsest",
      "worker-current",
      3,
      now + 10_000,
    ).changes,
    1,
  );
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT updated_at, lease_expires_at FROM edit_jobs WHERE id = 'heartbeat-worker'",
      ).get(),
    },
    { updated_at: now + 10_000, lease_expires_at: now + 70_000 },
  );
  assert.equal(
    db.prepare(renewSql).run(
      now + 20_000,
      now + 80_000,
      "heartbeat-worker",
      "palimpsest",
      "worker-current",
      2,
      now + 20_000,
    ).changes,
    0,
  );
  db.exec("UPDATE edit_jobs SET lease_expires_at = 1 WHERE id = 'heartbeat-worker'");
  assert.equal(
    db.prepare(renewSql).run(
      now + 30_000,
      now + 90_000,
      "heartbeat-worker",
      "palimpsest",
      "worker-current",
      3,
      now + 30_000,
    ).changes,
    0,
  );
  db.close();
});

test("an expired worker fails once without a hidden generation replay", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertSql, expireSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant("lib/palimpsest/queue.ts", "EXPIRE_ACTIVE_WORKER_SQL"),
  ]);
  const now = 19_750;
  assert.equal(
    db.prepare(insertSql).run(...reservationValues({
      jobId: "stopped-worker",
      authorId: "author-a",
      region: { x: 0, y: 0, width: 100, height: 100 },
      now: now - 100,
    })).changes,
    1,
  );
  db.prepare(
    `UPDATE edit_jobs
     SET state = 'generating', worker_token = 'worker-stopped',
         lease_fence = 1, lease_expires_at = ?, started_at = ?
     WHERE id = 'stopped-worker'`,
  ).run(now - 1, now - 100);

  assert.equal(
    db.prepare(expireSql).run(now, now, "palimpsest", now).changes,
    1,
  );
  assert.deepEqual(
    {
      ...db.prepare(
        `SELECT state, error_code, public_error_message, worker_token,
                lease_expires_at, attempt_count, completed_at
         FROM edit_jobs WHERE id = 'stopped-worker'`,
      ).get(),
    },
    {
      state: "failed",
      error_code: "QUEUE_LEASE_EXPIRED",
      public_error_message:
        "The generation worker stopped before finishing. Nothing was added to history.",
      worker_token: null,
      lease_expires_at: null,
      attempt_count: 0,
      completed_at: now,
    },
  );
  assert.equal(
    db.prepare(expireSql).run(now + 1, now + 1, "palimpsest", now + 1).changes,
    0,
  );
  db.close();
});

test("a fenced worker can record failure after its lease lapses", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertSql, failSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant("lib/palimpsest/queue.ts", "FAIL_CLAIMED_JOB_SQL"),
  ]);
  const now = 19_900;
  assert.equal(
    db.prepare(insertSql).run(...reservationValues({
      jobId: "late-failure",
      authorId: "author-a",
      region: { x: 0, y: 0, width: 100, height: 100 },
      now: now - 100,
    })).changes,
    1,
  );
  db.prepare(
    `UPDATE edit_jobs
     SET state = 'generating', worker_token = 'worker-late',
         lease_fence = 4, lease_expires_at = ?, started_at = ?
     WHERE id = 'late-failure'`,
  ).run(now - 1, now - 100);

  assert.equal(
    db.prepare(failSql).run(
      "failed",
      "PROVIDER_TEMPORARY",
      "The provider timed out. Nothing was added to history.",
      now,
      now,
      "late-failure",
      "worker-late",
      4,
    ).changes,
    1,
  );
  assert.deepEqual(
    {
      ...db.prepare(
        `SELECT state, error_code, worker_token, lease_expires_at, completed_at
         FROM edit_jobs WHERE id = 'late-failure'`,
      ).get(),
    },
    {
      state: "failed",
      error_code: "PROVIDER_TEMPORARY",
      worker_token: null,
      lease_expires_at: null,
      completed_at: now,
    },
  );
  assert.equal(
    db.prepare(failSql).run(
      "failed",
      "PROVIDER_TEMPORARY",
      "stale",
      now + 1,
      now + 1,
      "late-failure",
      "worker-late",
      4,
    ).changes,
    0,
  );
  db.close();
});

test("full-artwork reverts wait for every active reservation", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertEditSql, insertRevertSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_REVERT_RESERVATION_SQL"),
  ]);
  const now = 20_000;
  db.exec(`
    INSERT INTO revisions (
      id, artwork_id, sequence, parent_revision_id, origin, status,
      author_id, prompt, region_x, region_y, region_width, region_height, created_at
    ) VALUES ('target', 'palimpsest', -1, NULL, 'seed', 'accepted', 'archive',
      'Target', NULL, NULL, NULL, NULL, 0);
  `);
  db.prepare(insertEditSql).run(...reservationValues({
    jobId: "active-edit",
    authorId: "author-a",
    region: { x: 1800, y: 1800, width: 100, height: 100 },
    now,
  }));
  const revert = db.prepare(insertRevertSql);
  const revertValues = [
    "revert-job",
    "palimpsest",
    "author-b",
    "shared-nat",
    "r0",
    "target",
    "Restore",
    "idem-revert",
    "fingerprint-revert",
    now,
    now + 60_000,
    now,
    null,
    "request-revert",
    0,
    0,
    2,
  ];
  assert.equal(revert.run(...revertValues).changes, 0);

  db.exec("UPDATE edit_jobs SET state = 'failed', lease_expires_at = NULL");
  assert.equal(revert.run(...revertValues).changes, 1);
  const region = db.prepare(
    "SELECT region_x, region_y, region_width, region_height FROM edit_jobs WHERE id = 'revert-job'",
  ).get();
  assert.deepEqual({ ...region }, {
    region_x: 0,
    region_y: 0,
    region_width: 2048,
    region_height: 2048,
  });
  db.close();
});

test("queue retires obsolete modes while keeping reference-guided OpenAI work", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertSql, claimSql, retireSql, workStatusSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant("lib/palimpsest/queue.ts", "CLAIM_NEXT_JOB_SQL"),
    readSqlConstant("lib/palimpsest/queue.ts", "RETIRE_NON_LIVE_EDIT_JOBS_SQL"),
    readSqlConstant("lib/palimpsest/queue.ts", "QUEUE_WORK_STATUS_SQL"),
  ]);
  const now = 30_000;
  const insert = db.prepare(insertSql);
  const retiredValues = reservationValues({
    jobId: "claim-retired",
    authorId: "author-c",
    region: { x: 1000, y: 1000, width: 100, height: 100 },
    now: now - 1,
  });
  retiredValues[2] = "demo";
  insert.run(...retiredValues);
  insert.run(...reservationValues({
    jobId: "claim-reference",
    authorId: "author-a",
    region: { x: 0, y: 0, width: 100, height: 100 },
    now: now - 2,
    referenceBlobId: "reference-a",
  }));
  insert.run(...reservationValues({
    jobId: "active-reference",
    authorId: "author-b",
    region: { x: 250, y: 250, width: 100, height: 100 },
    now: now - 1,
    referenceBlobId: "reference-b",
  }));
  db.exec(`
    UPDATE edit_jobs
    SET state = 'moderating', worker_token = 'legacy-worker'
    WHERE id = 'active-reference';
  `);
  const placementValues = reservationValues({
    jobId: "claim-placement",
    authorId: "author-a",
    region: { x: 500, y: 500, width: 100, height: 100 },
    now,
    referenceBlobId: "placement-claim",
  });
  placementValues[2] = "placement";
  placementValues[15] = null;
  placementValues[16] = null;
  insert.run(...placementValues);
  insert.run(...reservationValues({
    jobId: "claim-openai",
    authorId: "author-c",
    region: { x: 1500, y: 1500, width: 100, height: 100 },
    now: now + 1,
  }));

  assert.deepEqual(
    {
      ...db.prepare(workStatusSql).get(
        "palimpsest",
        Number.MAX_SAFE_INTEGER,
        now + 2,
        now + 2,
        "palimpsest",
        now + 2,
      ),
    },
    { hasReady: 1, needsRecovery: 1 },
  );

  const claim = db.prepare(claimSql);
  const first = claim.get(
    "worker-a",
    now + 60_000,
    now,
    now,
    "palimpsest",
    now + 2,
    now + 2,
    now + 2,
    now + 2,
    now + 2,
  );
  assert.equal(first.id, "claim-reference");
  assert.equal(first.executionMode, "openai");
  assert.equal(first.referenceBlobId, "reference-a");

  assert.equal(
    db.prepare(retireSql).run(now + 2, now + 2, "palimpsest").changes,
    2,
  );

  const second = claim.get(
    "worker-b",
    now + 60_000,
    now,
    now,
    "palimpsest",
    now + 2,
    now + 2,
    now + 2,
    now + 2,
    now + 2,
  );
  assert.equal(second.id, "claim-openai");
  assert.equal(second.executionMode, "openai");
  assert.equal(second.referenceBlobId, null);
  assert.equal(first.state, "moderating");
  assert.equal(second.state, "moderating");
  assert.notEqual(first.workerToken, second.workerToken);
  assert.deepEqual(
    db.prepare(
      `SELECT id, state, error_code, worker_token, lease_expires_at
       FROM edit_jobs
       WHERE id IN (
         'claim-retired',
         'claim-placement',
         'active-reference'
       )
       ORDER BY id`,
    ).all().map((row) => ({ ...row })),
    [
      {
        id: "active-reference",
        state: "moderating",
        error_code: null,
        worker_token: "legacy-worker",
        lease_expires_at: 89999,
      },
      {
        id: "claim-placement",
        state: "failed",
        error_code: "NON_LIVE_MODE_REMOVED",
        worker_token: null,
        lease_expires_at: null,
      },
      {
        id: "claim-retired",
        state: "failed",
        error_code: "NON_LIVE_MODE_REMOVED",
        worker_token: null,
        lease_expires_at: null,
      },
    ],
  );
  db.close();
});

async function setupStaleCommit({ jobRegion, acceptedRegion, activeRegion = null }) {
  const db = await migratedDatabase();
  seedArtwork(db);
  db.prepare(`
    INSERT INTO revisions (
      id, artwork_id, sequence, parent_revision_id, origin, status, author_id,
      prompt, region_x, region_y, region_width, region_height, created_at
    ) VALUES ('r1', 'palimpsest', 1, 'r0', 'demo', 'accepted', 'author-b',
      'Accepted', ?, ?, ?, ?, 2)
  `).run(
    acceptedRegion.x,
    acceptedRegion.y,
    acceptedRegion.width,
    acceptedRegion.height,
  );
  db.exec("UPDATE artworks SET head_revision_id = 'r1', head_sequence = 1 WHERE id = 'palimpsest'");
  const now = 40_000;
  const lease = insertCommittingJob(db, { id: "commit-job", region: jobRegion, now });
  if (activeRegion) {
    db.prepare(`
      INSERT INTO edit_jobs (
        id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
        base_revision_id, prompt, region_x, region_y, region_width, region_height,
        idempotency_key, request_fingerprint, available_at, lease_expires_at,
        created_at, updated_at
      ) VALUES ('active-overlap', 'palimpsest', 'edit', 'queued', 'openai',
        'author-c', 'other', 'r1', 'Active', ?, ?, ?, ?, 'active-idem',
        'active-fingerprint', ?, ?, ?, ?)
    `).run(
      activeRegion.x,
      activeRegion.y,
      activeRegion.width,
      activeRegion.height,
      now,
      now + 60_000,
      now,
      now,
    );
  }
  return { db, now, lease };
}

test("stale non-overlapping generation rebases onto the current head", async () => {
  const { db, now, lease } = await setupStaleCommit({
    jobRegion: { x: 0, y: 0, width: 100, height: 100 },
    acceptedRegion: { x: 300, y: 300, width: 100, height: 100 },
  });
  const commitSql = await readSqlConstant(
    "lib/palimpsest/queue.ts",
    "COMMIT_PATCH_REVISION_SQL",
  );
  const result = db.prepare(commitSql).run(
    "r2",
    "commit-job",
    lease.token,
    lease.fence,
    lease.commitToken,
    lease.fence,
    now + 1,
  );
  assert.equal(result.changes, 1);
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT sequence, parent_revision_id FROM revisions WHERE id = 'r2'",
      ).get(),
    },
    { sequence: 2, parent_revision_id: "r1" },
  );
  db.close();
});

test("reference-guided OpenAI revisions commit under the same fenced history contract", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  db.exec(`
    INSERT INTO blobs (
      id, artwork_id, kind, r2_key, content_type, byte_length,
      sha256, width, height, created_at
    ) VALUES (
      'reference-commit-input', 'palimpsest', 'input', 'reference-commit.png',
      'image/png', 1, 'reference-commit-hash', 1024, 1024, 1
    );
  `);
  const now = 45_000;
  const lease = insertCommittingJob(db, {
    id: "reference-commit",
    region: { x: 200, y: 300, width: 149, height: 224 },
    now,
    executionMode: "openai",
    referenceBlobId: "reference-commit-input",
  });
  const commitSql = await readSqlConstant(
    "lib/palimpsest/queue.ts",
    "COMMIT_PATCH_REVISION_SQL",
  );
  assert.equal(
    db.prepare(commitSql).run(
      "reference-revision",
      "reference-commit",
      lease.token,
      lease.fence,
      lease.commitToken,
      lease.fence,
      now + 1,
    ).changes,
    1,
  );
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT origin, parent_revision_id, sequence FROM revisions WHERE id = 'reference-revision'",
      ).get(),
    },
    {
      origin: "openai",
      parent_revision_id: "r0",
      sequence: 1,
    },
  );
  db.close();
});

test("stale overlapping generation and superseded leases cannot commit", async () => {
  const commitSql = await readSqlConstant(
    "lib/palimpsest/queue.ts",
    "COMMIT_PATCH_REVISION_SQL",
  );

  const overlapping = await setupStaleCommit({
    jobRegion: { x: 320, y: 320, width: 100, height: 100 },
    acceptedRegion: { x: 300, y: 300, width: 100, height: 100 },
  });
  assert.equal(
    overlapping.db.prepare(commitSql).run(
      "blocked-revision",
      "commit-job",
      overlapping.lease.token,
      overlapping.lease.fence,
      overlapping.lease.commitToken,
      overlapping.lease.fence,
      overlapping.now + 1,
    ).changes,
    0,
  );
  overlapping.db.close();

  const superseded = await setupStaleCommit({
    jobRegion: { x: 0, y: 0, width: 100, height: 100 },
    acceptedRegion: { x: 300, y: 300, width: 100, height: 100 },
    activeRegion: { x: 50, y: 50, width: 100, height: 100 },
  });
  assert.equal(
    superseded.db.prepare(commitSql).run(
      "superseded-revision",
      "commit-job",
      superseded.lease.token,
      superseded.lease.fence,
      superseded.lease.commitToken,
      superseded.lease.fence,
      superseded.now + 1,
    ).changes,
    0,
  );
  superseded.db.exec("UPDATE edit_jobs SET lease_expires_at = 39999 WHERE id = 'commit-job'");
  superseded.db.exec("UPDATE edit_jobs SET state = 'failed', lease_expires_at = NULL WHERE id = 'active-overlap'");
  assert.equal(
    superseded.db.prepare(commitSql).run(
      "expired-revision",
      "commit-job",
      superseded.lease.token,
      superseded.lease.fence,
      superseded.lease.commitToken,
      superseded.lease.fence,
      superseded.now + 1,
    ).changes,
    0,
  );
  superseded.db.close();
});

test("empty drains are read-only while expired or ready work is discoverable", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertSql, statusSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant("lib/palimpsest/queue.ts", "QUEUE_WORK_STATUS_SQL"),
  ]);
  const now = 50_000;
  assert.deepEqual(
    { ...db.prepare(statusSql).get("palimpsest", Number.MAX_SAFE_INTEGER, now, now, "palimpsest", now) },
    { hasReady: 0, needsRecovery: 0 },
  );
  const preparing = reservationValues({
    jobId: "preparing",
    authorId: "author-a",
    region: { x: 0, y: 0, width: 100, height: 100 },
    now,
  });
  preparing[21] = Number.MAX_SAFE_INTEGER;
  db.prepare(insertSql).run(...preparing);
  assert.deepEqual(
    { ...db.prepare(statusSql).get("palimpsest", Number.MAX_SAFE_INTEGER, now, now, "palimpsest", now) },
    { hasReady: 0, needsRecovery: 0 },
  );
  db.exec("UPDATE edit_jobs SET lease_expires_at = 49999 WHERE id = 'preparing'");
  assert.equal(
    db.prepare(statusSql).get("palimpsest", Number.MAX_SAFE_INTEGER, now, now, "palimpsest", now).needsRecovery,
    1,
  );
  db.exec("UPDATE edit_jobs SET available_at = 50000, lease_expires_at = 99999 WHERE id = 'preparing'");
  assert.equal(
    db.prepare(statusSql).get("palimpsest", Number.MAX_SAFE_INTEGER, now, now, "palimpsest", now).hasReady,
    1,
  );
  db.close();
});

test("safe manual retry creates one immutable successor and keeps the failure visible", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  db.exec(`
    INSERT INTO blobs (
      id, artwork_id, kind, r2_key, content_type, byte_length,
      sha256, width, height, created_at
    ) VALUES
      ('retry-source', 'palimpsest', 'input', 'retry-source.png', 'image/png', 1, 's', 1024, 1024, 1),
      ('retry-mask', 'palimpsest', 'mask', 'retry-mask.png', 'image/png', 1, 'm', 1024, 1024, 1),
      ('retry-display', 'palimpsest', 'display_mask', 'retry-display.svg', 'image/svg+xml', 1, 'd', 1024, 1024, 1);
    INSERT INTO edit_jobs (
      id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
      base_revision_id, prompt, region_x, region_y, region_width, region_height,
      frame_x, frame_y, frame_width, frame_height,
      source_blob_id, mask_blob_id, display_mask_blob_id,
      idempotency_key, request_fingerprint, retry_token_hash, request_id,
      available_at, lease_expires_at, error_code, public_error_message,
      created_at, updated_at, completed_at
    ) VALUES (
      'failed-parent', 'palimpsest', 'edit', 'failed', 'openai', 'author-a', 'owner',
      'r0', 'Private prompt', 10, 20, 100, 120, 0, 0, 1024, 1024,
      'retry-source', 'retry-mask', 'retry-display', 'parent-key', 'fingerprint',
      'token-hash', 'request-parent', 1, NULL, 'PROVIDER_TEMPORARY', 'Try again.',
      1000, 2000, 2000
    ), (
      'failed-review', 'palimpsest', 'edit', 'failed', 'openai', 'author-a', 'owner',
      'r0', 'Private prompt', 140, 20, 100, 120, 0, 0, 1024, 1024,
      'retry-source', 'retry-mask', 'retry-display', 'review-parent-key', 'review-fingerprint',
      'token-hash', 'request-review-parent', 1, NULL, 'SUBJECT_OUT_OF_FRAME',
      'Use retry for one fresh attempt.', 1100, 2100, 2100
    );
  `);
  const retrySql = await readSqlConstant(
    "lib/palimpsest/store.ts",
    "INSERT_RETRY_JOB_SQL",
  );
  const recentSql = await readSqlConstant("lib/palimpsest/store.ts", "RECENT_JOBS_SQL");
  const beforeRetry = db.prepare(recentSql).all(2500, "palimpsest", "palimpsest");
  assert.equal(beforeRetry.find((row) => row.jobId === "failed-parent").retryable, 1);
  assert.equal(beforeRetry.find((row) => row.jobId === "failed-review").retryable, 1);
  assert.match(retrySql, /REFERENCE_REVIEW_FAILED/u);

  const values = [
    "retry-child", "failed-parent", "palimpsest", "owner", "token-hash",
    "child-key", "request-child", 3000, 63000, 0, 0, 3, 0, 12,
  ];
  assert.equal(db.prepare(retrySql).run(...values).changes, 1);
  assert.equal(db.prepare(retrySql).run("other-child", ...values.slice(1)).changes, 0);
  const reviewValues = [
    "retry-review-child", "failed-review", "palimpsest", "owner", "token-hash",
    "review-child-key", "request-review-child", 3100, 63100, 0, 0, 3, 0, 12,
  ];
  assert.equal(db.prepare(retrySql).run(...reviewValues).changes, 1);
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT state, error_code, completed_at FROM edit_jobs WHERE id = 'failed-parent'",
      ).get(),
    },
    { state: "failed", error_code: "PROVIDER_TEMPORARY", completed_at: 2000 },
  );
  assert.deepEqual(
    {
      ...db.prepare(
        `SELECT state, retry_of_job_id, source_blob_id, mask_blob_id,
                display_mask_blob_id, request_id
         FROM edit_jobs WHERE id = 'retry-child'`,
      ).get(),
    },
    {
      state: "queued",
      retry_of_job_id: "failed-parent",
      source_blob_id: "retry-source",
      mask_blob_id: "retry-mask",
      display_mask_blob_id: "retry-display",
      request_id: "request-child",
    },
  );
  const recent = db.prepare(recentSql).all(4000, "palimpsest", "palimpsest");
  const parent = recent.find((row) => row.jobId === "failed-parent");
  const reviewParent = recent.find((row) => row.jobId === "failed-review");
  assert.equal(parent.errorCode, "PROVIDER_TEMPORARY");
  assert.equal(parent.requestId, "request-parent");
  assert.equal(parent.retryable, 0, "a parent with an existing successor is no longer retryable");
  assert.equal(reviewParent.errorCode, "SUBJECT_OUT_OF_FRAME");
  assert.equal(reviewParent.retryable, 0);
  db.close();
});

test("reference-guided OpenAI failures retry with their immutable inputs", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  db.exec(`
    INSERT INTO blobs (
      id, artwork_id, kind, r2_key, content_type, byte_length,
      sha256, width, height, created_at
    ) VALUES
      ('legacy-source', 'palimpsest', 'input', 'legacy-source.png',
        'image/png', 1, 'legacy-source-hash', 1024, 1024, 1),
      ('legacy-mask', 'palimpsest', 'mask', 'legacy-mask.png',
        'image/png', 1, 'legacy-mask-hash', 1024, 1024, 1),
      ('legacy-display', 'palimpsest', 'display_mask', 'legacy-display.svg',
        'image/svg+xml', 1, 'legacy-display-hash', 1024, 1024, 1),
      ('legacy-reference', 'palimpsest', 'input', 'legacy-reference.png',
        'image/png', 1, 'legacy-reference-hash', 1024, 1024, 1);
    INSERT INTO edit_jobs (
      id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
      base_revision_id, prompt, region_x, region_y, region_width, region_height,
      frame_x, frame_y, frame_width, frame_height,
      source_blob_id, mask_blob_id, display_mask_blob_id, reference_blob_id,
      idempotency_key, request_fingerprint, retry_token_hash, request_id,
      available_at, lease_expires_at, error_code, public_error_message,
      created_at, updated_at, completed_at
    ) VALUES (
      'failed-legacy-reference', 'palimpsest', 'edit', 'failed', 'openai',
      'author-a', 'owner', 'r0', 'Old reference prompt', 10, 20, 100, 120,
      0, 0, 1024, 1024, 'legacy-source', 'legacy-mask', 'legacy-display',
      'legacy-reference', 'legacy-parent-key', 'legacy-fingerprint',
      'legacy-token-hash', 'legacy-request', 1, NULL, 'PROVIDER_TEMPORARY',
      'Try again.', 1000, 2000, 2000
    );
  `);
  const [retrySql, recentSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_RETRY_JOB_SQL"),
    readSqlConstant("lib/palimpsest/store.ts", "RECENT_JOBS_SQL"),
  ]);
  const recent = db.prepare(recentSql).all(
    2500,
    "palimpsest",
    "palimpsest",
  );
  assert.equal(
    recent.find((row) => row.jobId === "failed-legacy-reference").retryable,
    1,
  );
  assert.equal(
    db.prepare(retrySql).run(
      "legacy-retry-child",
      "failed-legacy-reference",
      "palimpsest",
      "owner",
      "legacy-token-hash",
      "legacy-child-key",
      "legacy-child-request",
      3000,
      63000,
      0,
      0,
      3,
      0,
      12,
    ).changes,
    1,
  );
  assert.deepEqual(
    {
      ...db.prepare(
        `SELECT execution_mode, source_blob_id, mask_blob_id,
                display_mask_blob_id, reference_blob_id, retry_of_job_id
         FROM edit_jobs WHERE id = 'legacy-retry-child'`,
      ).get(),
    },
    {
      execution_mode: "openai",
      source_blob_id: "legacy-source",
      mask_blob_id: "legacy-mask",
      display_mask_blob_id: "legacy-display",
      reference_blob_id: "legacy-reference",
      retry_of_job_id: "failed-legacy-reference",
    },
  );
  db.close();
});

test("retired direct-placement failures cannot be retried", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  db.exec(`
    INSERT INTO blobs (
      id, artwork_id, kind, r2_key, content_type, byte_length,
      sha256, width, height, created_at
    ) VALUES
      ('retired-input', 'palimpsest', 'input', 'retired.png', 'image/png',
        1, 'retired-hash', 1024, 1024, 1),
      ('retired-display', 'palimpsest', 'display_mask', 'retired-display.svg',
        'image/svg+xml', 1, 'display-hash', 1024, 1024, 1);
    INSERT INTO edit_jobs (
      id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
      base_revision_id, prompt, region_x, region_y, region_width, region_height,
      frame_x, frame_y, frame_width, frame_height,
      source_blob_id, mask_blob_id, display_mask_blob_id, reference_blob_id,
      idempotency_key, request_fingerprint, retry_token_hash, request_id,
      available_at, lease_expires_at, error_code, public_error_message,
      created_at, updated_at, completed_at
    ) VALUES (
      'failed-retired-placement', 'palimpsest', 'edit', 'failed', 'placement',
      'author-a', 'owner', 'r0', 'Old direct placement', 20, 30, 149, 224,
      0, 0, 1024, 1024, NULL, NULL, 'retired-display', 'retired-input',
      'retired-parent-key', 'retired-fingerprint', 'retired-token-hash',
      'retired-parent-request', 1, NULL, 'PROVIDER_TEMPORARY',
      'The retired contribution failed.', 1000, 2000, 2000
    );
  `);
  const [retrySql, recentSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_RETRY_JOB_SQL"),
    readSqlConstant("lib/palimpsest/store.ts", "RECENT_JOBS_SQL"),
  ]);
  const beforeRetry = db.prepare(recentSql).all(
    2500,
    "palimpsest",
    "palimpsest",
  );
  assert.equal(
    beforeRetry.find((row) => row.jobId === "failed-retired-placement").retryable,
    0,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM blobs").get().count, 2);

  const values = [
    "retired-retry",
    "failed-retired-placement",
    "palimpsest",
    "owner",
    "retired-token-hash",
    "retired-child-key",
    "retired-child-request",
    3000,
    63000,
    0,
    0,
    3,
    0,
    12,
  ];
  assert.equal(db.prepare(retrySql).run(...values).changes, 0);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM edit_jobs WHERE retry_of_job_id = 'failed-retired-placement'",
    ).get().count,
    0,
  );
  db.close();
});
