import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

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

async function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const [initial, parallel] = await Promise.all([
    readFile(new URL("drizzle/0000_slow_gambit.sql", root), "utf8"),
    readFile(new URL("drizzle/0001_parallel_regions.sql", root), "utf8"),
  ]);
  applyMigration(db, initial);
  applyMigration(db, parallel);
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
}) {
  return [
    jobId,
    "palimpsest",
    "demo",
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
    `idem-${jobId}`,
    `fingerprint-${jobId}`,
    now,
    now + 60_000,
    now,
  ];
}

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
    ) VALUES (?, 'palimpsest', 'edit', 'committing', 'demo', 'author-a', 'shared-nat',
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
    })).changes,
    1,
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

test("expired input preparation becomes terminal instead of remaining queued", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertSql, expireSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant(
      "lib/palimpsest/queue.ts",
      "EXPIRE_PREPARING_RESERVATION_SQL",
    ),
  ]);
  const now = 15_000;
  const values = reservationValues({
    jobId: "abandoned-preparation",
    authorId: "author-a",
    region: { x: 0, y: 0, width: 100, height: 100 },
    now,
  });
  values[20] = Number.MAX_SAFE_INTEGER;
  values[21] = now - 1;
  assert.equal(db.prepare(insertSql).run(...values).changes, 1);

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
  values[21] = now - 1;
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
  expired[21] = now - 1;
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

test("queue claims independent jobs without a requester or artwork-wide generation lock", async () => {
  const db = await migratedDatabase();
  seedArtwork(db);
  const [insertSql, claimSql] = await Promise.all([
    readSqlConstant("lib/palimpsest/store.ts", "INSERT_EDIT_RESERVATION_SQL"),
    readSqlConstant("lib/palimpsest/queue.ts", "CLAIM_NEXT_JOB_SQL"),
  ]);
  const now = 30_000;
  const insert = db.prepare(insertSql);
  insert.run(...reservationValues({
    jobId: "claim-a",
    authorId: "author-a",
    region: { x: 0, y: 0, width: 100, height: 100 },
    now,
  }));
  insert.run(...reservationValues({
    jobId: "claim-b",
    authorId: "author-b",
    region: { x: 500, y: 500, width: 100, height: 100 },
    now: now + 1,
  }));

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
  assert.equal(first.state, "generating");
  assert.equal(second.state, "generating");
  assert.notEqual(first.workerToken, second.workerToken);
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
      ) VALUES ('active-overlap', 'palimpsest', 'edit', 'queued', 'demo',
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
