import {
  ARTWORK_ID,
  DomainError,
  assertFreshBase,
  escapeXml,
  resolveTileLayers,
  serializeHistory,
  serializeRevision,
} from "./domain.mjs";
import type { AppEnv } from "./runtime";
import { publicJobMessage, sha256Hex } from "./runtime";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS artworks (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    tile_width INTEGER NOT NULL,
    tile_height INTEGER NOT NULL,
    columns INTEGER NOT NULL,
    rows INTEGER NOT NULL,
    head_revision_id TEXT,
    head_sequence INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS authors (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('visitor', 'seed')),
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    artwork_id TEXT NOT NULL REFERENCES artworks(id),
    kind TEXT NOT NULL CHECK (kind IN ('canonical','keyframe','patch','mask','display_mask','input')),
    r2_key TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY,
    artwork_id TEXT NOT NULL REFERENCES artworks(id),
    sequence INTEGER NOT NULL,
    parent_revision_id TEXT,
    job_id TEXT UNIQUE,
    origin TEXT NOT NULL CHECK (origin IN ('seed','demo','openai','revert')),
    status TEXT NOT NULL CHECK (status = 'accepted'),
    author_id TEXT NOT NULL REFERENCES authors(id),
    prompt TEXT NOT NULL,
    region_x INTEGER,
    region_y INTEGER,
    region_width INTEGER,
    region_height INTEGER,
    tile_x INTEGER,
    tile_y INTEGER,
    revert_target_revision_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (artwork_id, sequence)
  )`,
  `CREATE TABLE IF NOT EXISTS keyframes (
    id TEXT PRIMARY KEY,
    artwork_id TEXT NOT NULL REFERENCES artworks(id),
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    sequence INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (artwork_id, sequence)
  )`,
  `CREATE TABLE IF NOT EXISTS keyframe_tiles (
    keyframe_id TEXT NOT NULL REFERENCES keyframes(id),
    tile_x INTEGER NOT NULL,
    tile_y INTEGER NOT NULL,
    blob_id TEXT NOT NULL REFERENCES blobs(id),
    PRIMARY KEY (keyframe_id, tile_x, tile_y)
  )`,
  `CREATE TABLE IF NOT EXISTS revision_patches (
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    tile_x INTEGER NOT NULL,
    tile_y INTEGER NOT NULL,
    patch_blob_id TEXT NOT NULL REFERENCES blobs(id),
    display_mask_blob_id TEXT REFERENCES blobs(id),
    PRIMARY KEY (revision_id, tile_x, tile_y)
  )`,
  `CREATE TABLE IF NOT EXISTS edit_jobs (
    id TEXT PRIMARY KEY,
    artwork_id TEXT NOT NULL REFERENCES artworks(id),
    kind TEXT NOT NULL CHECK (kind IN ('edit','revert')),
    state TEXT NOT NULL CHECK (state IN ('queued','moderating','generating','committing','succeeded','stale','rejected','failed')),
    execution_mode TEXT NOT NULL CHECK (execution_mode IN ('demo','openai','none')),
    author_id TEXT NOT NULL REFERENCES authors(id),
    requester_hash TEXT NOT NULL,
    base_revision_id TEXT NOT NULL,
    target_revision_id TEXT,
    prompt TEXT NOT NULL,
    tile_x INTEGER,
    tile_y INTEGER,
    region_x INTEGER,
    region_y INTEGER,
    region_width INTEGER,
    region_height INTEGER,
    source_blob_id TEXT,
    mask_blob_id TEXT,
    display_mask_blob_id TEXT,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL,
    worker_token TEXT,
    lock_fence INTEGER,
    lease_expires_at INTEGER,
    result_revision_id TEXT,
    openai_request_id TEXT,
    error_code TEXT,
    public_error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    UNIQUE (artwork_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS queue_locks (
    artwork_id TEXT PRIMARY KEY REFERENCES artworks(id),
    state TEXT NOT NULL CHECK (state IN ('idle','held')),
    owner_token TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    job_id TEXT,
    acquired_at INTEGER,
    heartbeat_at INTEGER,
    lease_expires_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS rate_windows (
    requester_hash TEXT NOT NULL,
    scope TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (requester_hash, scope, window_start)
  )`,
  `CREATE INDEX IF NOT EXISTS revisions_artwork_created_idx ON revisions (artwork_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS blobs_artwork_kind_idx ON blobs (artwork_id, kind)`,
  `CREATE INDEX IF NOT EXISTS edit_jobs_queue_idx ON edit_jobs (artwork_id, state, available_at, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS edit_jobs_requester_idx ON edit_jobs (requester_hash, state)`,
  `CREATE TRIGGER IF NOT EXISTS revisions_immutable_update
    BEFORE UPDATE ON revisions
    BEGIN SELECT RAISE(ABORT, 'accepted revisions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS revisions_immutable_delete
    BEFORE DELETE ON revisions
    BEGIN SELECT RAISE(ABORT, 'accepted revisions are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS revisions_require_current_parent
    BEFORE INSERT ON revisions
    WHEN NEW.sequence > 0 AND NEW.job_id IS NOT NULL AND (
      SELECT head_revision_id FROM artworks WHERE id = NEW.artwork_id
    ) IS NOT NEW.parent_revision_id
    BEGIN SELECT RAISE(ABORT, 'stale base revision'); END`,
];

let schemaReady: Promise<void> | null = null;

async function ensureSchema(env: AppEnv): Promise<void> {
  schemaReady ??= (async () => {
    await env.DB.batch(schemaStatements.map((statement) => env.DB.prepare(statement)));
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  await schemaReady;
}

type SeedRevision = {
  id: string;
  authorId: string;
  author: string;
  prompt: string;
  timestamp: number;
  tile?: { x: number; y: number };
  region?: { x: number; y: number; width: number; height: number };
  svg?: string;
};

const seedRevisions: SeedRevision[] = [
  {
    id: "rev-seed-000",
    authorId: "author-archive",
    author: "Palimpsest Archive",
    prompt: "The first ground: paper, graphite, and a river remembered.",
    timestamp: Date.UTC(2026, 4, 4, 18, 15),
  },
  {
    id: "rev-seed-001",
    authorId: "author-mara",
    author: "Mara Bell",
    prompt: "Let the botanical forms surface at the western edge.",
    timestamp: Date.UTC(2026, 4, 16, 9, 42),
    tile: { x: 0, y: 0 },
    region: { x: 52, y: 116, width: 310, height: 360 },
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><g fill="none" stroke="#3f463e" stroke-width="3" opacity=".28"><path d="M82 460 C145 372 182 238 198 116"/><path d="M155 300 C106 274 72 235 54 188"/><path d="M177 238 C222 210 263 166 286 114"/><ellipse cx="112" cy="252" rx="38" ry="14" transform="rotate(34 112 252)"/><ellipse cx="228" cy="188" rx="42" ry="15" transform="rotate(-37 228 188)"/></g></svg>`,
  },
  {
    id: "rev-seed-002",
    authorId: "author-ivo",
    author: "Ivo Chen",
    prompt: "Trace the vanished rooms lightly through the eastern field.",
    timestamp: Date.UTC(2026, 5, 1, 21, 5),
    tile: { x: 1, y: 1 },
    region: { x: 402, y: 348, width: 460, height: 280 },
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><g fill="none" stroke="#282722" stroke-width="2" opacity=".22"><path d="M422 384 H782 V612 H608 V522 H518 V612 H422 Z"/><path d="M470 432 H730 V560 H648 V486 H552 V560 H470 Z"/><circle cx="602" cy="486" r="76"/><path d="M602 410 V562 M526 486 H678"/></g></svg>`,
  },
  {
    id: "rev-seed-003",
    authorId: "author-noor",
    author: "Noor A.",
    prompt: "Warm the lower meadow with a veil of oxidized earth.",
    timestamp: Date.UTC(2026, 5, 19, 6, 28),
    tile: { x: 0, y: 1 },
    region: { x: 104, y: 520, width: 500, height: 250 },
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><g opacity=".16"><path fill="#9b5d32" d="M104 646 C208 548 354 536 604 574 L604 770 L104 770 Z"/><path fill="none" stroke="#6b432c" stroke-width="5" d="M128 704 C268 590 438 612 576 662"/></g></svg>`,
  },
  {
    id: "rev-seed-004",
    authorId: "author-elena",
    author: "Elena Voss",
    prompt: "Carry one vermilion thread across the old fault line.",
    timestamp: Date.UTC(2026, 6, 3, 16, 12),
    tile: { x: 1, y: 0 },
    region: { x: 32, y: 610, width: 510, height: 220 },
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><path d="M32 716 C138 668 214 756 306 702 S448 642 542 688" fill="none" stroke="#a63b29" stroke-width="7" stroke-linecap="round" opacity=".78"/></svg>`,
  },
  {
    id: "rev-seed-005",
    authorId: "author-conservator",
    author: "The Night Conservator",
    prompt: "Leave a graphite constellation where the river narrows.",
    timestamp: Date.UTC(2026, 6, 12, 23, 47),
    tile: { x: 0, y: 0 },
    region: { x: 590, y: 570, width: 330, height: 300 },
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><g fill="#272824" opacity=".36"><circle cx="622" cy="646" r="4"/><circle cx="680" cy="610" r="3"/><circle cx="742" cy="672" r="5"/><circle cx="804" cy="622" r="3"/><circle cx="862" cy="718" r="4"/><circle cx="716" cy="792" r="3"/></g><path d="M622 646 L680 610 L742 672 L804 622 L862 718 L716 792 L622 646" fill="none" stroke="#272824" stroke-width="1.5" opacity=".18"/></svg>`,
  },
];

export async function ensurePalimpsest(env: AppEnv, requestUrl: string): Promise<void> {
  await ensureSchema(env);
  const existing = await env.DB.prepare("SELECT id FROM artworks WHERE id = ?")
    .bind(ARTWORK_ID)
    .first();
  if (existing) return;

  const origin = new URL(requestUrl).origin;
  const baseBlobs: Array<{
    id: string;
    key: string;
    hash: string;
    bytes: Uint8Array;
    tileX: number;
    tileY: number;
  }> = [];

  for (const tileY of [0, 1]) {
    for (const tileX of [0, 1]) {
      const assetUrl = new URL(`/seed/tile-${tileX}-${tileY}.png`, origin);
      const response = env.ASSETS
        ? await env.ASSETS.fetch(new Request(assetUrl))
        : await fetch(assetUrl);
      if (!response.ok) {
        throw new DomainError("SERVICE_UNAVAILABLE", "The canonical artwork seed is unavailable.");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const hash = await sha256Hex(bytes);
      const key = `artworks/palimpsest/keyframes/000000/tile-${tileX}-${tileY}-${hash}.png`;
      await env.BLOBS.put(key, bytes, {
        httpMetadata: { contentType: "image/png" },
        customMetadata: { sha256: hash, immutable: "true" },
      });
      baseBlobs.push({
        id: `blob-base-${tileX}-${tileY}`,
        key,
        hash,
        bytes,
        tileX,
        tileY,
      });
    }
  }

  const patchBlobs: Array<{
    id: string;
    key: string;
    hash: string;
    bytes: Uint8Array;
    sequence: number;
  }> = [];
  for (let sequence = 1; sequence < seedRevisions.length; sequence += 1) {
    const bytes = new TextEncoder().encode(seedRevisions[sequence].svg ?? "");
    const hash = await sha256Hex(bytes);
    const key = `artworks/palimpsest/patches/${seedRevisions[sequence].id}/seed-${hash}.svg`;
    await env.BLOBS.put(key, bytes, {
      httpMetadata: { contentType: "image/svg+xml" },
      customMetadata: { sha256: hash, immutable: "true" },
    });
    patchBlobs.push({
      id: `blob-seed-patch-${String(sequence).padStart(3, "0")}`,
      key,
      hash,
      bytes,
      sequence,
    });
  }

  const statements: D1PreparedStatement[] = [];
  const createdAt = seedRevisions[0].timestamp;
  statements.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO artworks
       (id, slug, title, width, height, tile_width, tile_height, columns, rows, head_revision_id, head_sequence, created_at)
       VALUES (?, ?, ?, 2048, 2048, 1024, 1024, 2, 2, ?, 5, ?)`,
    ).bind(ARTWORK_ID, ARTWORK_ID, "Palimpsest", "rev-seed-005", createdAt),
  );

  for (const revision of seedRevisions) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO authors (id, display_name, source, created_at) VALUES (?, ?, 'seed', ?)",
      ).bind(revision.authorId, revision.author, revision.timestamp),
    );
  }
  for (const blob of baseBlobs) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO blobs
         (id, artwork_id, kind, r2_key, content_type, byte_length, sha256, width, height, created_at)
         VALUES (?, ?, 'keyframe', ?, 'image/png', ?, ?, 1024, 1024, ?)`,
      ).bind(blob.id, ARTWORK_ID, blob.key, blob.bytes.byteLength, blob.hash, createdAt),
    );
  }
  for (const blob of patchBlobs) {
    const revision = seedRevisions[blob.sequence];
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO blobs
         (id, artwork_id, kind, r2_key, content_type, byte_length, sha256, width, height, created_at)
         VALUES (?, ?, 'patch', ?, 'image/svg+xml', ?, ?, 1024, 1024, ?)`,
      ).bind(
        blob.id,
        ARTWORK_ID,
        blob.key,
        blob.bytes.byteLength,
        blob.hash,
        revision.timestamp,
      ),
    );
  }

  for (let sequence = 0; sequence < seedRevisions.length; sequence += 1) {
    const revision = seedRevisions[sequence];
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO revisions
         (id, artwork_id, sequence, parent_revision_id, origin, status, author_id, prompt,
          region_x, region_y, region_width, region_height, tile_x, tile_y, created_at)
         VALUES (?, ?, ?, ?, 'seed', 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        revision.id,
        ARTWORK_ID,
        sequence,
        sequence === 0 ? null : seedRevisions[sequence - 1].id,
        revision.authorId,
        revision.prompt,
        revision.region?.x ?? null,
        revision.region?.y ?? null,
        revision.region?.width ?? null,
        revision.region?.height ?? null,
        revision.tile?.x ?? null,
        revision.tile?.y ?? null,
        revision.timestamp,
      ),
    );
  }

  statements.push(
    env.DB.prepare(
      "INSERT OR IGNORE INTO keyframes (id, artwork_id, revision_id, sequence, created_at) VALUES ('keyframe-000000', ?, 'rev-seed-000', 0, ?)",
    ).bind(ARTWORK_ID, createdAt),
  );
  for (const blob of baseBlobs) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO keyframe_tiles (keyframe_id, tile_x, tile_y, blob_id) VALUES ('keyframe-000000', ?, ?, ?)",
      ).bind(blob.tileX, blob.tileY, blob.id),
    );
  }
  for (const blob of patchBlobs) {
    const revision = seedRevisions[blob.sequence];
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO revision_patches
         (revision_id, tile_x, tile_y, patch_blob_id, display_mask_blob_id)
         VALUES (?, ?, ?, ?, NULL)`,
      ).bind(revision.id, revision.tile?.x, revision.tile?.y, blob.id),
    );
  }
  statements.push(
    env.DB.prepare(
      "INSERT OR IGNORE INTO queue_locks (artwork_id, state, fence) VALUES (?, 'idle', 0)",
    ).bind(ARTWORK_ID),
  );

  await env.DB.batch(statements);
}

type RevisionRow = {
  id: string;
  sequence: number;
  parentRevisionId: string | null;
  origin: string;
  prompt: string;
  regionX: number | null;
  regionY: number | null;
  regionWidth: number | null;
  regionHeight: number | null;
  tileX: number | null;
  tileY: number | null;
  revertTargetRevisionId: string | null;
  createdAt: number;
  displayName: string;
};

const revisionSelect = `SELECT
  r.id AS id,
  r.sequence AS sequence,
  r.parent_revision_id AS parentRevisionId,
  r.origin AS origin,
  r.prompt AS prompt,
  r.region_x AS regionX,
  r.region_y AS regionY,
  r.region_width AS regionWidth,
  r.region_height AS regionHeight,
  r.tile_x AS tileX,
  r.tile_y AS tileY,
  r.revert_target_revision_id AS revertTargetRevisionId,
  r.created_at AS createdAt,
  a.display_name AS displayName
FROM revisions r
JOIN authors a ON a.id = r.author_id`;

export async function listHistory(env: AppEnv, requestUrl: string) {
  await ensurePalimpsest(env, requestUrl);
  const result = await env.DB.prepare(
    `${revisionSelect} WHERE r.artwork_id = ? ORDER BY r.sequence ASC LIMIT 500`,
  )
    .bind(ARTWORK_ID)
    .all<RevisionRow>();
  const revisions = serializeHistory(result.results);
  const head = revisions.at(-1);
  return {
    artwork: {
      id: ARTWORK_ID,
      title: "Palimpsest",
      width: 2048,
      height: 2048,
      tileSize: 1024,
      columns: 2,
      rows: 2,
    },
    revisions,
    headRevisionId: head?.id ?? null,
    editing: {
      openaiAvailable: Boolean(env.OPENAI_API_KEY),
      defaultMode: "demo",
      demoNotice: "Deterministic demo edits are active; choose live AI editing when available.",
    },
  };
}

export async function getArtworkState(
  env: AppEnv,
  requestUrl: string,
  revisionId?: string | null,
) {
  await ensurePalimpsest(env, requestUrl);
  const artwork = await env.DB.prepare(
    "SELECT head_revision_id AS headRevisionId, head_sequence AS headSequence FROM artworks WHERE id = ?",
  )
    .bind(ARTWORK_ID)
    .first<{ headRevisionId: string; headSequence: number }>();
  if (!artwork) throw new DomainError("NOT_FOUND", "The artwork could not be found.");

  const selected = await env.DB.prepare(
    `${revisionSelect} WHERE r.artwork_id = ? AND r.id = ? LIMIT 1`,
  )
    .bind(ARTWORK_ID, revisionId || artwork.headRevisionId)
    .first<RevisionRow>();
  if (!selected) throw new DomainError("NOT_FOUND", "That revision is not part of Palimpsest.");

  const revisions = await env.DB.prepare(
    `${revisionSelect} WHERE r.artwork_id = ? AND r.sequence <= ? ORDER BY r.sequence ASC`,
  )
    .bind(ARTWORK_ID, selected.sequence)
    .all<RevisionRow>();
  const bases = await env.DB.prepare(
    `SELECT
       kt.tile_x AS tileX,
       kt.tile_y AS tileY,
       b.id AS blobId,
       b.sha256 AS sha256
     FROM keyframes k
     JOIN keyframe_tiles kt ON kt.keyframe_id = k.id
     JOIN blobs b ON b.id = kt.blob_id
     WHERE k.artwork_id = ? AND k.sequence = 0
     ORDER BY kt.tile_y, kt.tile_x`,
  )
    .bind(ARTWORK_ID)
    .all<{ tileX: number; tileY: number; blobId: string; sha256: string }>();
  const patches = await env.DB.prepare(
    `SELECT
       rp.revision_id AS revisionId,
       rp.tile_x AS tileX,
       rp.tile_y AS tileY,
       p.id AS blobId,
       p.sha256 AS sha256,
       m.id AS maskBlobId
     FROM revision_patches rp
     JOIN revisions r ON r.id = rp.revision_id
     JOIN blobs p ON p.id = rp.patch_blob_id
     LEFT JOIN blobs m ON m.id = rp.display_mask_blob_id
     WHERE r.artwork_id = ? AND r.sequence <= ?
     ORDER BY r.sequence ASC`,
  )
    .bind(ARTWORK_ID, selected.sequence)
    .all<{
      revisionId: string;
      tileX: number;
      tileY: number;
      blobId: string;
      sha256: string;
      maskBlobId: string | null;
    }>();

  const resolved = resolveTileLayers(revisions.results, bases.results, patches.results);
  return {
    artwork: { id: ARTWORK_ID, width: 2048, height: 2048, tileSize: 1024 },
    headRevisionId: artwork.headRevisionId,
    isCurrent: selected.id === artwork.headRevisionId,
    revision: serializeRevision(selected),
    tiles: resolved.map((tile) => ({
      x: tile.x,
      y: tile.y,
      base: {
        blobId: tile.base.blobId,
        url: `/api/blobs/${encodeURIComponent(tile.base.blobId)}`,
        sha256: tile.base.sha256,
      },
      layers: tile.layers.map((layer: Record<string, unknown>) => ({
        revisionId: layer.revisionId,
        blobId: layer.blobId,
        url: `/api/blobs/${encodeURIComponent(String(layer.blobId))}`,
        sha256: layer.sha256,
        maskUrl: layer.maskBlobId
          ? `/api/blobs/${encodeURIComponent(String(layer.maskBlobId))}`
          : null,
      })),
    })),
  };
}

export async function getActivity(env: AppEnv, requestUrl: string) {
  await ensurePalimpsest(env, requestUrl);
  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued,
       SUM(CASE WHEN state IN ('moderating','generating','committing') THEN 1 ELSE 0 END) AS active
     FROM edit_jobs WHERE artwork_id = ?`,
  )
    .bind(ARTWORK_ID)
    .first<{ queued: number | null; active: number | null }>();
  const recent = await env.DB.prepare(
    `${revisionSelect} WHERE r.artwork_id = ? ORDER BY r.sequence DESC LIMIT 8`,
  )
    .bind(ARTWORK_ID)
    .all<RevisionRow>();
  return {
    queue: { queued: Number(counts?.queued ?? 0), active: Number(counts?.active ?? 0) },
    recent: recent.results.map(serializeRevision),
  };
}

export async function getBlobRecord(env: AppEnv, blobId: string) {
  return env.DB.prepare(
    `SELECT id, kind, r2_key AS r2Key, content_type AS contentType,
            byte_length AS byteLength, sha256
     FROM blobs WHERE id = ? AND artwork_id = ?`,
  )
    .bind(blobId, ARTWORK_ID)
    .first<{
      id: string;
      kind: string;
      r2Key: string;
      contentType: string;
      byteLength: number;
      sha256: string;
    }>();
}

export async function getHead(env: AppEnv) {
  const head = await env.DB.prepare(
    "SELECT head_revision_id AS id, head_sequence AS sequence FROM artworks WHERE id = ?",
  )
    .bind(ARTWORK_ID)
    .first<{ id: string; sequence: number }>();
  if (!head) throw new DomainError("NOT_FOUND", "The artwork could not be found.");
  return head;
}

export async function requesterHash(env: AppEnv, request: Request): Promise<string> {
  const address = request.headers.get("CF-Connecting-IP") ?? "local-preview";
  return sha256Hex(`${env.RATE_LIMIT_SALT ?? "palimpsest-v1"}:${address}`);
}

export async function enforceRateLimit(
  env: AppEnv,
  hash: string,
  scope: string,
  limit: number,
  windowMs: number,
) {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await env.DB.prepare(
    `INSERT INTO rate_windows (requester_hash, scope, window_start, count, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (requester_hash, scope, window_start)
     DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
     RETURNING count`,
  )
    .bind(hash, scope, windowStart, now)
    .first<{ count: number }>();
  if (Number(row?.count ?? 1) > limit) {
    throw new DomainError("RATE_LIMITED", "Too many contributions from this connection. Try again later.");
  }
  return Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
}

export function createDisplayMaskSvg(mask: {
  region: { x: number; y: number; width: number; height: number };
  fill: boolean;
  strokes: Array<{ width: number; points: Array<{ x: number; y: number }> }>;
}): string {
  const { x, y, width, height } = mask.region;
  const content = mask.fill
    ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="white"/>`
    : mask.strokes
        .map((stroke) => {
          const points = stroke.points.map((point) => `${point.x + x},${point.y + y}`).join(" ");
          return `<polyline points="${points}" fill="none" stroke="white" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
        })
        .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${content}</svg>`;
}

type InsertEditInput = {
  baseRevisionId: string;
  displayName: string;
  prompt: string;
  tile: { x: number; y: number };
  region: { x: number; y: number; width: number; height: number };
  fill: boolean;
  strokes: Array<{ width: number; points: Array<{ x: number; y: number }> }>;
  executionMode: "demo" | "openai";
  idempotencyKey: string;
  requesterHash: string;
  sourceBytes: Uint8Array;
  maskBytes: Uint8Array;
};

export async function insertEditJob(env: AppEnv, input: InsertEditInput) {
  const head = await getHead(env);
  assertFreshBase(input.baseRevisionId, head.id);

  const normalizedMeta = JSON.stringify({
    baseRevisionId: input.baseRevisionId,
    prompt: input.prompt,
    tile: input.tile,
    region: input.region,
    fill: input.fill,
    strokes: input.strokes,
    executionMode: input.executionMode,
  });
  const maskHash = await sha256Hex(input.maskBytes);
  const fingerprint = await sha256Hex(`${normalizedMeta}:${maskHash}`);
  const existing = await env.DB.prepare(
    `SELECT id, request_fingerprint AS requestFingerprint
     FROM edit_jobs WHERE artwork_id = ? AND idempotency_key = ?`,
  )
    .bind(ARTWORK_ID, input.idempotencyKey)
    .first<{ id: string; requestFingerprint: string }>();
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "That submission key was already used for a different edit.");
    }
    return getPublicJob(env, existing.id);
  }

  const nonterminal = await env.DB.prepare(
    `SELECT id FROM edit_jobs
     WHERE requester_hash = ? AND state IN ('queued','moderating','generating','committing')
     LIMIT 1`,
  )
    .bind(input.requesterHash)
    .first();
  if (nonterminal) {
    throw new DomainError("RATE_LIMITED", "Finish your current contribution before adding another.");
  }

  const jobId = crypto.randomUUID();
  const authorId = crypto.randomUUID();
  const sourceBlobId = crypto.randomUUID();
  const maskBlobId = crypto.randomUUID();
  const displayMaskBlobId = crypto.randomUUID();
  const now = Date.now();
  const sourceHash = await sha256Hex(input.sourceBytes);
  const displayMask = new TextEncoder().encode(
    createDisplayMaskSvg({
      region: input.region,
      fill: input.fill,
      strokes: input.strokes,
    }),
  );
  const displayMaskHash = await sha256Hex(displayMask);
  const sourceKey = `artworks/palimpsest/inputs/${jobId}/source-${sourceHash}.png`;
  const maskKey = `artworks/palimpsest/masks/${jobId}/provider-${maskHash}.png`;
  const displayMaskKey = `artworks/palimpsest/masks/${jobId}/display-${displayMaskHash}.svg`;

  await Promise.all([
    env.BLOBS.put(sourceKey, input.sourceBytes, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { sha256: sourceHash, private: "true" },
    }),
    env.BLOBS.put(maskKey, input.maskBytes, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { sha256: maskHash, private: "true" },
    }),
    env.BLOBS.put(displayMaskKey, displayMask, {
      httpMetadata: { contentType: "image/svg+xml" },
      customMetadata: { sha256: displayMaskHash, immutable: "true" },
    }),
  ]);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO authors (id, display_name, source, created_at) VALUES (?, ?, 'visitor', ?)",
    ).bind(authorId, input.displayName, now),
    env.DB.prepare(
      `INSERT INTO blobs
       (id, artwork_id, kind, r2_key, content_type, byte_length, sha256, width, height, created_at)
       VALUES (?, ?, 'input', ?, 'image/png', ?, ?, 1024, 1024, ?)`,
    ).bind(sourceBlobId, ARTWORK_ID, sourceKey, input.sourceBytes.byteLength, sourceHash, now),
    env.DB.prepare(
      `INSERT INTO blobs
       (id, artwork_id, kind, r2_key, content_type, byte_length, sha256, width, height, created_at)
       VALUES (?, ?, 'mask', ?, 'image/png', ?, ?, 1024, 1024, ?)`,
    ).bind(maskBlobId, ARTWORK_ID, maskKey, input.maskBytes.byteLength, maskHash, now),
    env.DB.prepare(
      `INSERT INTO blobs
       (id, artwork_id, kind, r2_key, content_type, byte_length, sha256, width, height, created_at)
       VALUES (?, ?, 'display_mask', ?, 'image/svg+xml', ?, ?, 1024, 1024, ?)`,
    ).bind(
      displayMaskBlobId,
      ARTWORK_ID,
      displayMaskKey,
      displayMask.byteLength,
      displayMaskHash,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO edit_jobs
       (id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
        base_revision_id, prompt, tile_x, tile_y, region_x, region_y, region_width,
        region_height, source_blob_id, mask_blob_id, display_mask_blob_id,
        idempotency_key, request_fingerprint, available_at, created_at, updated_at)
       VALUES (?, ?, 'edit', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      jobId,
      ARTWORK_ID,
      input.executionMode,
      authorId,
      input.requesterHash,
      input.baseRevisionId,
      input.prompt,
      input.tile.x,
      input.tile.y,
      input.region.x,
      input.region.y,
      input.region.width,
      input.region.height,
      sourceBlobId,
      maskBlobId,
      displayMaskBlobId,
      input.idempotencyKey,
      fingerprint,
      now,
      now,
      now,
    ),
  ]);

  return getPublicJob(env, jobId);
}

export async function insertRevertJob(
  env: AppEnv,
  input: {
    baseRevisionId: string;
    targetRevisionId: string;
    displayName: string;
    requesterHash: string;
    idempotencyKey: string;
  },
) {
  const head = await getHead(env);
  assertFreshBase(input.baseRevisionId, head.id);
  const target = await env.DB.prepare(
    "SELECT sequence FROM revisions WHERE artwork_id = ? AND id = ?",
  )
    .bind(ARTWORK_ID, input.targetRevisionId)
    .first<{ sequence: number }>();
  if (!target || target.sequence >= head.sequence) {
    throw new DomainError("INVALID_REQUEST", "Choose an earlier revision to restore.");
  }
  const fingerprint = await sha256Hex(
    JSON.stringify({ base: input.baseRevisionId, target: input.targetRevisionId }),
  );
  const existing = await env.DB.prepare(
    "SELECT id, request_fingerprint AS requestFingerprint FROM edit_jobs WHERE artwork_id = ? AND idempotency_key = ?",
  )
    .bind(ARTWORK_ID, input.idempotencyKey)
    .first<{ id: string; requestFingerprint: string }>();
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "That submission key was already used.");
    }
    return getPublicJob(env, existing.id);
  }

  const authorId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO authors (id, display_name, source, created_at) VALUES (?, ?, 'visitor', ?)",
    ).bind(authorId, input.displayName, now),
    env.DB.prepare(
      `INSERT INTO edit_jobs
       (id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
        base_revision_id, target_revision_id, prompt, idempotency_key,
        request_fingerprint, available_at, created_at, updated_at)
       VALUES (?, ?, 'revert', 'queued', 'none', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      jobId,
      ARTWORK_ID,
      authorId,
      input.requesterHash,
      input.baseRevisionId,
      input.targetRevisionId,
      `Restore revision ${target.sequence} as a new layer of history.`,
      input.idempotencyKey,
      fingerprint,
      now,
      now,
      now,
    ),
  ]);
  return getPublicJob(env, jobId);
}

export async function getPublicJob(env: AppEnv, jobId: string) {
  const row = await env.DB.prepare(
    `SELECT
       id, state, execution_mode AS executionMode,
       result_revision_id AS resultRevisionId,
       error_code AS errorCode,
       public_error_message AS publicErrorMessage,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM edit_jobs WHERE id = ? AND artwork_id = ?`,
  )
    .bind(jobId, ARTWORK_ID)
    .first<{
      id: string;
      state: string;
      executionMode: string;
      resultRevisionId: string | null;
      errorCode: string | null;
      publicErrorMessage: string | null;
      createdAt: number;
      updatedAt: number;
    }>();
  if (!row) throw new DomainError("NOT_FOUND", "That queue item could not be found.");
  const ahead =
    row.state === "queued"
      ? await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM edit_jobs
           WHERE artwork_id = ? AND state = 'queued' AND created_at < ?`,
        )
          .bind(ARTWORK_ID, row.createdAt)
          .first<{ count: number }>()
      : null;
  return {
    id: row.id,
    state: row.state,
    executionMode: row.executionMode,
    position: row.state === "queued" ? Number(ahead?.count ?? 0) + 1 : null,
    resultRevisionId: row.resultRevisionId,
    message: publicJobMessage(row.state),
    error: row.errorCode
      ? { code: row.errorCode, message: row.publicErrorMessage }
      : null,
    submittedAt: new Date(Number(row.createdAt)).toISOString(),
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
  };
}

export function makeDemoPatchSvg(
  prompt: string,
  region: { x: number; y: number; width: number; height: number },
  seed: string,
) {
  const numeric = Number.parseInt(seed.slice(0, 8), 16);
  const colors = ["#a63b29", "#8b633d", "#30322f", "#b06b43"];
  const primary = colors[numeric % colors.length];
  const secondary = colors[(numeric + 2) % colors.length];
  const lines = Array.from({ length: 9 }, (_, index) => {
    const y = region.y + 18 + ((index * 37 + numeric) % Math.max(24, region.height - 36));
    const bow = 18 + ((numeric >> (index % 12)) % 44);
    return `<path d="M ${region.x - 24} ${y} Q ${region.x + region.width / 2} ${y - bow} ${region.x + region.width + 24} ${y + 8}"/>`;
  }).join("");
  const safePrompt = escapeXml(prompt.slice(0, 80));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" aria-label="Deterministic demo patch: ${safePrompt}">
    <defs><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".045" numOctaves="3" seed="${numeric % 97}"/><feColorMatrix values="0 0 0 0 .35 0 0 0 0 .22 0 0 0 0 .14 0 0 0 .25 0"/></filter></defs>
    <rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" fill="${primary}" opacity=".18" filter="url(#grain)"/>
    <g fill="none" stroke="${secondary}" stroke-width="4" opacity=".52">${lines}</g>
    <g fill="${primary}" opacity=".42"><circle cx="${region.x + region.width * 0.28}" cy="${region.y + region.height * 0.36}" r="9"/><circle cx="${region.x + region.width * 0.7}" cy="${region.y + region.height * 0.66}" r="6"/></g>
  </svg>`;
}
