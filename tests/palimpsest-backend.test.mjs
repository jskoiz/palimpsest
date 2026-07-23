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
  const [initial, parallel, liveOnly, whiteCanvasReset, referenceImages, durableJobs] = await Promise.all([
    readFile(new URL("drizzle/0000_slow_gambit.sql", root), "utf8"),
    readFile(new URL("drizzle/0001_parallel_regions.sql", root), "utf8"),
    readFile(new URL("drizzle/0002_live_ai_only.sql", root), "utf8"),
    readFile(new URL("drizzle/0003_white_canvas_reset.sql", root), "utf8"),
    readFile(new URL("drizzle/0004_reference_images.sql", root), "utf8"),
    readFile(new URL("drizzle/0009_durable_job_attempts.sql", root), "utf8"),
  ]);
  applyMigration(db, initial);
  applyMigration(db, parallel);
  applyMigration(db, liveOnly);
  applyMigration(db, whiteCanvasReset);
  applyMigration(db, referenceImages);
  if (durable) applyMigration(db, durableJobs);
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
  token = `worker-${id}`,
  fence = 1,
}) {
  db.prepare(`
    INSERT INTO edit_jobs (
      id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
      base_revision_id, prompt, region_x, region_y, region_width, region_height,
      frame_x, frame_y, frame_width, frame_height, display_mask_blob_id,
      idempotency_key, request_fingerprint, available_at, worker_token,
      lease_fence, lease_expires_at, created_at, updated_at
    ) VALUES (?, 'palimpsest', 'edit', 'committing', 'openai', 'author-a', 'shared-nat',
      ?, 'Commit patch', ?, ?, ?, ?, 0, 0, 1024, 1024, 'display-mask',
      ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    baseRevisionId,
    region.x,
    region.y,
    region.width,
    region.height,
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

test("framing-test reset clears the current archive and durable job state", async () => {
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
    new URL("drizzle/0010_reset_framing_test_archive.sql", root),
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
      `${table} must be empty after the framing-test reset`,
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

test("expired active work cannot be revived over a newer reservation", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertSql, claimSql, supersedeSql, requeueSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant("lib/palimpsest/queue.ts", "CLAIM_NEXT_JOB_SQL"),
    readSqlConstant(
      "lib/palimpsest/queue.ts",
      "SUPERSEDE_EXPIRED_ACTIVE_RESERVATION_SQL",
    ),
    readSqlConstant(
      "lib/palimpsest/queue.ts",
      "REQUEUE_EXPIRED_ACTIVE_RESERVATION_SQL",
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
  assert.equal(
    db.prepare(requeueSql).run(
      now,
      now + 60_000,
      now,
      "palimpsest",
      now,
      2,
      now,
    ).changes,
    0,
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

test("queue retires non-live jobs before claiming independent live work", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertSql, claimSql, retireSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant("lib/palimpsest/queue.ts", "CLAIM_NEXT_JOB_SQL"),
    readSqlConstant("lib/palimpsest/queue.ts", "RETIRE_NON_LIVE_EDIT_JOBS_SQL"),
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
    jobId: "claim-a",
    authorId: "author-a",
    region: { x: 0, y: 0, width: 100, height: 100 },
    now,
    referenceBlobId: "reference-claim-a",
  }));
  insert.run(...reservationValues({
    jobId: "claim-b",
    authorId: "author-b",
    region: { x: 500, y: 500, width: 100, height: 100 },
    now: now + 1,
  }));

  assert.equal(
    db.prepare(retireSql).run(now + 2, now + 2, "palimpsest").changes,
    1,
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
  assert.deepEqual(new Set([first.id, second.id]), new Set(["claim-a", "claim-b"]));
  assert.equal(first.referenceBlobId, "reference-claim-a");
  assert.equal(first.state, "moderating");
  assert.equal(second.state, "moderating");
  assert.notEqual(first.workerToken, second.workerToken);
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT state, error_code FROM edit_jobs WHERE id = 'claim-retired'",
      ).get(),
    },
    { state: "failed", error_code: "NON_LIVE_MODE_REMOVED" },
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
