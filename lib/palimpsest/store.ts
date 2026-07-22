import {
  ARTWORK_ID,
  ARTWORK_SIZE,
  DomainError,
  createDisplayMaskSvg,
  displayMaskForLayer,
  resolveLayerStack,
  serializeHistory,
  serializeRevision,
} from "./domain.mjs";
import {
  generationFrameForRegion,
  regionRelativeToFrame,
} from "./geometry.mjs";
import type { AppEnv } from "./runtime";
import { publicJobMessage, sha256Hex } from "./runtime";

export type GlobalRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type GenerationFrame = GlobalRegion;

export const RESERVATION_LEASE_MS = 4 * 60 * 1000;
export const PREPARING_AVAILABLE_AT = Number.MAX_SAFE_INTEGER;
const PURPLE_SEED_REVISION_ID = "rev-seed-purple-000";
const PURPLE_SEED_KEYFRAME_ID = "keyframe-purple-000000";

type SeedRevision = {
  id: string;
  authorId: string;
  author: string;
  prompt: string;
  timestamp: number;
};

const seedRevisions: SeedRevision[] = [
  {
    id: PURPLE_SEED_REVISION_ID,
    authorId: "author-archive",
    author: "Palimpsest Archive",
    prompt: "Purple abstract canvas.",
    timestamp: Date.UTC(2026, 6, 21, 20, 30),
  },
];

export async function ensurePalimpsest(env: AppEnv, requestUrl: string): Promise<void> {
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
        id: `blob-purple-base-${tileX}-${tileY}`,
        key,
        hash,
        bytes,
        tileX,
        tileY,
      });
    }
  }

  const statements: D1PreparedStatement[] = [];
  const createdAt = seedRevisions[0].timestamp;
  statements.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO artworks
       (id, slug, title, width, height, tile_width, tile_height, columns, rows, head_revision_id, head_sequence, created_at)
       VALUES (?, ?, ?, 2048, 2048, 1024, 1024, 2, 2, ?, 0, ?)`,
    ).bind(ARTWORK_ID, ARTWORK_ID, "Palimpsest", seedRevisions[0].id, createdAt),
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
  for (let sequence = 0; sequence < seedRevisions.length; sequence += 1) {
    const revision = seedRevisions[sequence];
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO revisions
         (id, artwork_id, sequence, parent_revision_id, origin, status, author_id, prompt,
          region_x, region_y, region_width, region_height, created_at)
         VALUES (?, ?, ?, ?, 'seed', 'accepted', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        revision.id,
        ARTWORK_ID,
        sequence,
        sequence === 0 ? null : seedRevisions[sequence - 1].id,
        revision.authorId,
        revision.prompt,
        null,
        null,
        null,
        null,
        revision.timestamp,
      ),
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO keyframes
       (id, artwork_id, revision_id, sequence, created_at)
       VALUES (?, ?, ?, 0, ?)`,
    ).bind(PURPLE_SEED_KEYFRAME_ID, ARTWORK_ID, PURPLE_SEED_REVISION_ID, createdAt),
  );
  for (const blob of baseBlobs) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO keyframe_tiles
         (keyframe_id, tile_x, tile_y, blob_id)
         VALUES (?, ?, ?, ?)`,
      ).bind(PURPLE_SEED_KEYFRAME_ID, blob.tileX, blob.tileY, blob.id),
    );
  }
  statements.push(
    env.DB.prepare(
      "INSERT OR IGNORE INTO artwork_commit_locks (artwork_id, fence) VALUES (?, 0)",
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
      available: Boolean(env.OPENAI_API_KEY?.trim()),
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
       p.id AS blobId,
       p.sha256 AS sha256,
       m.id AS maskBlobId,
       r.origin AS origin,
       rp.frame_x AS frameX,
       rp.frame_y AS frameY,
       rp.frame_width AS frameWidth,
       rp.frame_height AS frameHeight
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
      blobId: string;
      sha256: string;
      maskBlobId: string | null;
      origin: string;
      frameX: number;
      frameY: number;
      frameWidth: number;
      frameHeight: number;
    }>();

  const resolvedLayers = resolveLayerStack(revisions.results, patches.results);
  return {
    artwork: { id: ARTWORK_ID, width: 2048, height: 2048, tileSize: 1024 },
    headRevisionId: artwork.headRevisionId,
    isCurrent: selected.id === artwork.headRevisionId,
    revision: serializeRevision(selected),
    tiles: bases.results.map((tile) => ({
      x: tile.tileX,
      y: tile.tileY,
      base: {
        blobId: tile.blobId,
        url: `/api/blobs/${encodeURIComponent(tile.blobId)}?sha256=${encodeURIComponent(tile.sha256)}`,
        sha256: tile.sha256,
      },
    })),
    layers: resolvedLayers.map((layer: Record<string, unknown>) => {
      const blobId = String(layer.blobId);
      const maskBlobId = displayMaskForLayer(
        String(layer.origin),
        typeof layer.maskBlobId === "string" ? layer.maskBlobId : null,
      );
      return {
        revisionId: String(layer.revisionId),
        blobId,
        url: `/api/blobs/${encodeURIComponent(blobId)}?sha256=${encodeURIComponent(String(layer.sha256))}`,
        sha256: String(layer.sha256),
        maskUrl: maskBlobId
          ? `/api/blobs/${encodeURIComponent(maskBlobId)}`
          : null,
        frame: {
          x: Number(layer.frameX),
          y: Number(layer.frameY),
          width: Number(layer.frameWidth),
          height: Number(layer.frameHeight),
        },
      };
    }),
  };
}

type ActiveRegionRow = {
  jobId: string;
  author: string;
  state: string;
  regionX: number;
  regionY: number;
  regionWidth: number;
  regionHeight: number;
  reservationActive: number;
  createdAt: number;
  updatedAt: number;
};

function serializeActiveRegion(row: ActiveRegionRow) {
  return {
    jobId: row.jobId,
    author: row.author,
    state: row.state,
    region: {
      x: Number(row.regionX),
      y: Number(row.regionY),
      width: Number(row.regionWidth),
      height: Number(row.regionHeight),
    },
    reservationActive: Boolean(row.reservationActive),
    createdAt: new Date(Number(row.createdAt)).toISOString(),
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
  };
}

export const ACTIVE_REGIONS_SQL = `SELECT
  j.id AS jobId,
  a.display_name AS author,
  j.state AS state,
  j.region_x AS regionX,
  j.region_y AS regionY,
  j.region_width AS regionWidth,
  j.region_height AS regionHeight,
  CASE WHEN j.lease_expires_at > ? THEN 1 ELSE 0 END AS reservationActive,
  j.created_at AS createdAt,
  j.updated_at AS updatedAt
FROM edit_jobs j
JOIN authors a ON a.id = j.author_id
WHERE j.artwork_id = ?
  AND j.state IN ('queued', 'moderating', 'generating', 'committing')
  AND j.region_x IS NOT NULL
  AND j.region_y IS NOT NULL
  AND j.region_width > 0
  AND j.region_height > 0
ORDER BY j.created_at ASC, j.id ASC`;

export async function getActiveRegions(env: AppEnv, now = Date.now()) {
  const rows = await env.DB.prepare(ACTIVE_REGIONS_SQL)
    .bind(now, ARTWORK_ID)
    .all<ActiveRegionRow>();
  return rows.results.map(serializeActiveRegion);
}

export async function getActivity(env: AppEnv, requestUrl: string) {
  await ensurePalimpsest(env, requestUrl);
  const now = Date.now();
  const [counts, activeRegions] = await Promise.all([
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN state = 'queued' AND lease_expires_at > ? THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN state IN ('moderating','generating','committing') AND lease_expires_at > ? THEN 1 ELSE 0 END) AS active
       FROM edit_jobs WHERE artwork_id = ?`,
    )
      .bind(now, now, ARTWORK_ID)
      .first<{ queued: number | null; active: number | null }>(),
    getActiveRegions(env, now),
  ]);
  const recent = await env.DB.prepare(
    `${revisionSelect} WHERE r.artwork_id = ? ORDER BY r.sequence DESC LIMIT 8`,
  )
    .bind(ARTWORK_ID)
    .all<RevisionRow>();
  return {
    queue: { queued: Number(counts?.queued ?? 0), active: Number(counts?.active ?? 0) },
    activeRegions,
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

type InsertEditInput = {
  baseRevisionId: string;
  displayName: string;
  prompt: string;
  region: GlobalRegion;
  fill: boolean;
  strokes: Array<{ width: number; points: Array<{ x: number; y: number }> }>;
  idempotencyKey: string;
  requesterHash: string;
  sourceBytes: Uint8Array;
  maskBytes: Uint8Array;
  referenceBytes?: Uint8Array;
};

type ExistingIdempotencyRow = {
  id: string;
  requestFingerprint: string;
};

type RevisionConflictRow = {
  revisionId: string;
  sequence: number;
  regionX: number;
  regionY: number;
  regionWidth: number;
  regionHeight: number;
};

function firstResult<T>(result: D1Result<unknown> | undefined): T | null {
  return (result?.results?.[0] as T | undefined) ?? null;
}

function regionBusyError(conflict: ActiveRegionRow): DomainError {
  const error = new DomainError(
    "REGION_BUSY",
    "That part of the artwork is already reserved. Choose a non-overlapping area or wait for the active edit to finish.",
  ) as DomainError & { details: { conflict: ReturnType<typeof serializeActiveRegion> } };
  error.details = { conflict: serializeActiveRegion(conflict) };
  return error;
}

const activeConflictSql = `SELECT
  j.id AS jobId,
  a.display_name AS author,
  j.state AS state,
  j.region_x AS regionX,
  j.region_y AS regionY,
  j.region_width AS regionWidth,
  j.region_height AS regionHeight,
  j.created_at AS createdAt,
  j.updated_at AS updatedAt
FROM edit_jobs j
JOIN authors a ON a.id = j.author_id
WHERE j.artwork_id = ?
  AND j.state IN ('queued', 'moderating', 'generating', 'committing')
  AND j.lease_expires_at > ?
  AND j.region_x < ? + ?
  AND j.region_x + j.region_width > ?
  AND j.region_y < ? + ?
  AND j.region_y + j.region_height > ?
ORDER BY j.created_at ASC, j.id ASC
LIMIT 1`;

export const INSERT_EDIT_RESERVATION_SQL = `WITH candidate(
  job_id, artwork_id, execution_mode, author_id, requester_hash, base_revision_id,
  prompt, region_x, region_y, region_width, region_height,
  frame_x, frame_y, frame_width, frame_height,
  source_blob_id, mask_blob_id, display_mask_blob_id, reference_blob_id,
  idempotency_key, request_fingerprint, available_at, lease_expires_at, now_ms
) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
INSERT OR IGNORE INTO edit_jobs (
  id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
  base_revision_id, prompt, region_x, region_y, region_width, region_height,
  frame_x, frame_y, frame_width, frame_height,
  source_blob_id, mask_blob_id, display_mask_blob_id, reference_blob_id,
  idempotency_key, request_fingerprint, available_at, lease_expires_at,
  created_at, updated_at
)
SELECT
  c.job_id, c.artwork_id, 'edit', 'queued', c.execution_mode, c.author_id,
  c.requester_hash, c.base_revision_id, c.prompt,
  c.region_x, c.region_y, c.region_width, c.region_height,
  c.frame_x, c.frame_y, c.frame_width, c.frame_height,
  c.source_blob_id, c.mask_blob_id, c.display_mask_blob_id, c.reference_blob_id,
  c.idempotency_key, c.request_fingerprint, c.available_at, c.lease_expires_at,
  c.now_ms, c.now_ms
FROM candidate c
WHERE EXISTS (
  SELECT 1 FROM revisions base
  WHERE base.artwork_id = c.artwork_id AND base.id = c.base_revision_id
)
AND NOT EXISTS (
  SELECT 1 FROM edit_jobs active
  WHERE active.artwork_id = c.artwork_id
    AND active.state IN ('queued', 'moderating', 'generating', 'committing')
    AND active.lease_expires_at > c.now_ms
    AND active.region_x < c.region_x + c.region_width
    AND active.region_x + active.region_width > c.region_x
    AND active.region_y < c.region_y + c.region_height
    AND active.region_y + active.region_height > c.region_y
)
AND NOT EXISTS (
  SELECT 1
  FROM revisions base
  JOIN revisions accepted
    ON accepted.artwork_id = base.artwork_id
   AND accepted.sequence > base.sequence
  WHERE base.artwork_id = c.artwork_id
    AND base.id = c.base_revision_id
    AND accepted.region_x IS NOT NULL
    AND accepted.region_x < c.region_x + c.region_width
    AND accepted.region_x + accepted.region_width > c.region_x
    AND accepted.region_y < c.region_y + c.region_height
    AND accepted.region_y + accepted.region_height > c.region_y
)`;

export const INSERT_REVERT_RESERVATION_SQL = `WITH candidate(
  job_id, artwork_id, author_id, requester_hash, base_revision_id,
  target_revision_id, prompt, idempotency_key, request_fingerprint,
  available_at, lease_expires_at, now_ms
) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
INSERT OR IGNORE INTO edit_jobs (
  id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
  base_revision_id, target_revision_id, prompt,
  region_x, region_y, region_width, region_height,
  idempotency_key, request_fingerprint, available_at, lease_expires_at,
  created_at, updated_at
)
SELECT
  c.job_id, c.artwork_id, 'revert', 'queued', 'none', c.author_id,
  c.requester_hash, c.base_revision_id, c.target_revision_id, c.prompt,
  0, 0, 2048, 2048,
  c.idempotency_key, c.request_fingerprint, c.available_at, c.lease_expires_at,
  c.now_ms, c.now_ms
FROM candidate c
JOIN artworks artwork
  ON artwork.id = c.artwork_id AND artwork.head_revision_id = c.base_revision_id
JOIN revisions base
  ON base.artwork_id = c.artwork_id AND base.id = c.base_revision_id
JOIN revisions target
  ON target.artwork_id = c.artwork_id
 AND target.id = c.target_revision_id
 AND target.sequence < base.sequence
WHERE NOT EXISTS (
  SELECT 1 FROM edit_jobs active
  WHERE active.artwork_id = c.artwork_id
    AND active.state IN ('queued', 'moderating', 'generating', 'committing')
    AND active.lease_expires_at > c.now_ms
)`;

async function markPreparationFailed(
  env: AppEnv,
  jobId: string,
  code: string,
  message: string,
) {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE edit_jobs
     SET state = 'failed', error_code = ?, public_error_message = ?,
         lease_expires_at = NULL, updated_at = ?, completed_at = ?
     WHERE id = ? AND artwork_id = ? AND state = 'queued' AND worker_token IS NULL`,
  )
    .bind(code, message, now, now, jobId, ARTWORK_ID)
    .run();
}

async function getIdempotentJob(
  env: AppEnv,
  idempotencyKey: string,
): Promise<ExistingIdempotencyRow | null> {
  return env.DB.prepare(
    `SELECT id, request_fingerprint AS requestFingerprint
     FROM edit_jobs WHERE artwork_id = ? AND idempotency_key = ? LIMIT 1`,
  )
    .bind(ARTWORK_ID, idempotencyKey)
    .first<ExistingIdempotencyRow>();
}

export async function insertEditJob(env: AppEnv, input: InsertEditInput) {
  const frame = generationFrameForRegion(input.region);
  const normalizedMeta = JSON.stringify({
    baseRevisionId: input.baseRevisionId,
    prompt: input.prompt,
    region: input.region,
    frame,
    fill: input.fill,
    strokes: input.strokes,
    generation: "live-ai",
  });
  const [sourceHash, maskHash, referenceHash] = await Promise.all([
    sha256Hex(input.sourceBytes),
    sha256Hex(input.maskBytes),
    input.referenceBytes ? sha256Hex(input.referenceBytes) : Promise.resolve(null),
  ]);
  const fingerprint = await sha256Hex(
    `${normalizedMeta}:${sourceHash}:${maskHash}:${referenceHash ?? "none"}`,
  );

  const jobId = crypto.randomUUID();
  const authorId = crypto.randomUUID();
  const sourceBlobId = crypto.randomUUID();
  const maskBlobId = crypto.randomUUID();
  const displayMaskBlobId = crypto.randomUUID();
  const referenceBlobId = input.referenceBytes ? crypto.randomUUID() : null;
  const now = Date.now();
  const leaseExpiresAt = now + RESERVATION_LEASE_MS;
  const displayMask = new TextEncoder().encode(
    createDisplayMaskSvg({
      region: regionRelativeToFrame(input.region, frame),
      fill: input.fill,
      strokes: input.strokes,
    }),
  );
  const displayMaskHash = await sha256Hex(displayMask);
  const sourceKey = `artworks/palimpsest/inputs/${jobId}/source-${sourceHash}.png`;
  const maskKey = `artworks/palimpsest/masks/${jobId}/provider-${maskHash}.png`;
  const displayMaskKey = `artworks/palimpsest/masks/${jobId}/display-${displayMaskHash}.svg`;
  const referenceKey = referenceHash
    ? `artworks/palimpsest/inputs/${jobId}/reference-${referenceHash}.png`
    : null;

  const reservation = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, request_fingerprint AS requestFingerprint
       FROM edit_jobs WHERE artwork_id = ? AND idempotency_key = ? LIMIT 1`,
    ).bind(ARTWORK_ID, input.idempotencyKey),
    env.DB.prepare(activeConflictSql).bind(
      ARTWORK_ID,
      now,
      input.region.x,
      input.region.width,
      input.region.x,
      input.region.y,
      input.region.height,
      input.region.y,
    ),
    env.DB.prepare(
      `SELECT
         accepted.id AS revisionId,
         accepted.sequence AS sequence,
         accepted.region_x AS regionX,
         accepted.region_y AS regionY,
         accepted.region_width AS regionWidth,
         accepted.region_height AS regionHeight
       FROM revisions base
       JOIN revisions accepted
         ON accepted.artwork_id = base.artwork_id
        AND accepted.sequence > base.sequence
       WHERE base.artwork_id = ?
         AND base.id = ?
         AND accepted.region_x IS NOT NULL
         AND accepted.region_x < ? + ?
         AND accepted.region_x + accepted.region_width > ?
         AND accepted.region_y < ? + ?
         AND accepted.region_y + accepted.region_height > ?
       ORDER BY accepted.sequence ASC
       LIMIT 1`,
    ).bind(
      ARTWORK_ID,
      input.baseRevisionId,
      input.region.x,
      input.region.width,
      input.region.x,
      input.region.y,
      input.region.height,
      input.region.y,
    ),
    env.DB.prepare(
      "SELECT id FROM revisions WHERE artwork_id = ? AND id = ? LIMIT 1",
    ).bind(ARTWORK_ID, input.baseRevisionId),
    env.DB.prepare(
      "INSERT INTO authors (id, display_name, source, created_at) VALUES (?, ?, 'visitor', ?)",
    ).bind(authorId, input.displayName, now),
    env.DB.prepare(INSERT_EDIT_RESERVATION_SQL).bind(
      jobId,
      ARTWORK_ID,
      "openai",
      authorId,
      input.requesterHash,
      input.baseRevisionId,
      input.prompt,
      input.region.x,
      input.region.y,
      input.region.width,
      input.region.height,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      sourceBlobId,
      maskBlobId,
      displayMaskBlobId,
      referenceBlobId,
      input.idempotencyKey,
      fingerprint,
      PREPARING_AVAILABLE_AT,
      leaseExpiresAt,
      now,
    ),
    env.DB.prepare(
      `DELETE FROM authors
       WHERE id = ? AND NOT EXISTS (SELECT 1 FROM edit_jobs WHERE id = ?)`,
    ).bind(authorId, jobId),
  ]);

  const existing = firstResult<ExistingIdempotencyRow>(reservation[0]);
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "That submission key was already used for a different edit.",
      );
    }
    return getPublicJob(env, existing.id);
  }

  if (Number(reservation[5]?.meta.changes ?? 0) === 0) {
    const racedIdempotency = await getIdempotentJob(env, input.idempotencyKey);
    if (racedIdempotency) {
      if (racedIdempotency.requestFingerprint !== fingerprint) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "That submission key was already used for a different edit.",
        );
      }
      return getPublicJob(env, racedIdempotency.id);
    }
    const conflict = firstResult<ActiveRegionRow>(reservation[1]);
    if (conflict) throw regionBusyError(conflict);
    if (!firstResult<{ id: string }>(reservation[3])) {
      throw new DomainError(
        "STALE_BASE_REVISION",
        "The selected base revision is no longer available.",
      );
    }
    const revisionConflict = firstResult<RevisionConflictRow>(reservation[2]);
    if (revisionConflict) {
      throw new DomainError(
        "STALE_BASE_REVISION",
        `Revision ${revisionConflict.sequence} changed the reserved area after your selected base. Review the latest artwork before trying again.`,
      );
    }
    throw new DomainError(
      "INTERNAL_ERROR",
      "The edit reservation could not be created safely.",
    );
  }

  const blobWrites = [
    env.BLOBS.put(sourceKey, input.sourceBytes, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { sha256: sourceHash, private: "true" },
    }),
    env.BLOBS.put(maskKey, input.maskBytes, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { sha256: maskHash, private: "true" },
    }),
  ];
  if (input.referenceBytes && referenceHash && referenceKey) {
    blobWrites.push(
      env.BLOBS.put(referenceKey, input.referenceBytes, {
        httpMetadata: { contentType: "image/png" },
        customMetadata: { sha256: referenceHash, private: "true" },
      }),
    );
  }
  blobWrites.push(env.BLOBS.put(displayMaskKey, displayMask, {
    httpMetadata: { contentType: "image/svg+xml" },
    customMetadata: { sha256: displayMaskHash, immutable: "true" },
  }));
  try {
    await Promise.all(blobWrites);
  } catch (error) {
    await markPreparationFailed(
      env,
      jobId,
      "STORAGE_WRITE_FAILED",
      "The edit inputs could not be stored safely. Nothing was added to history.",
    );
    throw error;
  }

  const readyAt = Date.now();
  const statements = [
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
  ];
  if (input.referenceBytes && referenceBlobId && referenceHash && referenceKey) {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO blobs
           (id, artwork_id, kind, r2_key, content_type, byte_length, sha256, width, height, created_at)
           VALUES (?, ?, 'input', ?, 'image/png', ?, ?, 1024, 1024, ?)`,
        )
        .bind(
          referenceBlobId,
          ARTWORK_ID,
          referenceKey,
          input.referenceBytes.byteLength,
          referenceHash,
          now,
        ),
    );
  }
  statements.push(
    env.DB
      .prepare(
        `INSERT INTO blobs
         (id, artwork_id, kind, r2_key, content_type, byte_length, sha256, width, height, created_at)
         VALUES (?, ?, 'display_mask', ?, 'image/svg+xml', ?, ?, 1024, 1024, ?)`,
      )
      .bind(
        displayMaskBlobId,
        ARTWORK_ID,
        displayMaskKey,
        displayMask.byteLength,
        displayMaskHash,
        now,
      ),
  );
  statements.push(
    env.DB.prepare(
      `UPDATE edit_jobs
       SET available_at = ?, updated_at = ?, lease_expires_at = ?
       WHERE id = ? AND artwork_id = ? AND state = 'queued' AND worker_token IS NULL
         AND (
           lease_expires_at > ? OR NOT EXISTS (
             SELECT 1 FROM edit_jobs active
             WHERE active.artwork_id = edit_jobs.artwork_id
               AND active.id <> edit_jobs.id
               AND active.state IN ('queued', 'moderating', 'generating', 'committing')
               AND active.lease_expires_at > ?
               AND active.region_x < edit_jobs.region_x + edit_jobs.region_width
               AND active.region_x + active.region_width > edit_jobs.region_x
               AND active.region_y < edit_jobs.region_y + edit_jobs.region_height
               AND active.region_y + active.region_height > edit_jobs.region_y
           )
         )`,
    ).bind(
      readyAt,
      readyAt,
      readyAt + RESERVATION_LEASE_MS,
      jobId,
      ARTWORK_ID,
      readyAt,
      readyAt,
    ),
  );
  try {
    const metadata = await env.DB.batch(statements);
    if (Number(metadata.at(-1)?.meta.changes ?? 0) !== 1) {
      await markPreparationFailed(
        env,
        jobId,
        "QUEUE_LEASE_EXPIRED",
        "The edit reservation expired while its inputs were being stored. Nothing was added to history.",
      );
      const conflict = await env.DB.prepare(activeConflictSql)
        .bind(
          ARTWORK_ID,
          readyAt,
          input.region.x,
          input.region.width,
          input.region.x,
          input.region.y,
          input.region.height,
          input.region.y,
        )
        .first<ActiveRegionRow>();
      if (conflict && conflict.jobId !== jobId) throw regionBusyError(conflict);
      throw new DomainError(
        "QUEUE_LEASE_EXPIRED",
        "The edit reservation expired before the upload became ready.",
      );
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    await markPreparationFailed(
      env,
      jobId,
      "STORAGE_METADATA_FAILED",
      "The edit inputs could not be recorded safely. Nothing was added to history.",
    );
    throw error;
  }

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
  const targetRevision = await env.DB.prepare(
    "SELECT sequence FROM revisions WHERE artwork_id = ? AND id = ? LIMIT 1",
  )
    .bind(ARTWORK_ID, input.targetRevisionId)
    .first<{ sequence: number }>();
  if (!targetRevision) {
    throw new DomainError("INVALID_REQUEST", "Choose an earlier revision to restore.");
  }
  const fingerprint = await sha256Hex(
    JSON.stringify({ base: input.baseRevisionId, target: input.targetRevisionId }),
  );
  const authorId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const now = Date.now();
  const leaseExpiresAt = now + RESERVATION_LEASE_MS;
  const reservation = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, request_fingerprint AS requestFingerprint
       FROM edit_jobs WHERE artwork_id = ? AND idempotency_key = ? LIMIT 1`,
    ).bind(ARTWORK_ID, input.idempotencyKey),
    env.DB.prepare(activeConflictSql).bind(
      ARTWORK_ID,
      now,
      0,
      ARTWORK_SIZE,
      0,
      0,
      ARTWORK_SIZE,
      0,
    ),
    env.DB.prepare(
      `SELECT
         base.sequence AS baseSequence,
         target.sequence AS targetSequence,
         artwork.head_revision_id AS headRevisionId
       FROM artworks artwork
       JOIN revisions base
         ON base.artwork_id = artwork.id AND base.id = ?
       JOIN revisions target
         ON target.artwork_id = artwork.id AND target.id = ?
       WHERE artwork.id = ?`,
    ).bind(input.baseRevisionId, input.targetRevisionId, ARTWORK_ID),
    env.DB.prepare(
      "INSERT INTO authors (id, display_name, source, created_at) VALUES (?, ?, 'visitor', ?)",
    ).bind(authorId, input.displayName, now),
    env.DB.prepare(INSERT_REVERT_RESERVATION_SQL).bind(
      jobId,
      ARTWORK_ID,
      authorId,
      input.requesterHash,
      input.baseRevisionId,
      input.targetRevisionId,
      `Restore revision ${targetRevision.sequence} as a new layer of history.`,
      input.idempotencyKey,
      fingerprint,
      now,
      leaseExpiresAt,
      now,
    ),
    env.DB.prepare(
      `DELETE FROM authors
       WHERE id = ? AND NOT EXISTS (SELECT 1 FROM edit_jobs WHERE id = ?)`,
    ).bind(authorId, jobId),
  ]);

  const existing = firstResult<ExistingIdempotencyRow>(reservation[0]);
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "That submission key was already used for a different restore request.",
      );
    }
    return getPublicJob(env, existing.id);
  }

  if (Number(reservation[4]?.meta.changes ?? 0) === 0) {
    const racedIdempotency = await getIdempotentJob(env, input.idempotencyKey);
    if (racedIdempotency) {
      if (racedIdempotency.requestFingerprint !== fingerprint) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "That submission key was already used for a different restore request.",
        );
      }
      return getPublicJob(env, racedIdempotency.id);
    }
    const conflict = firstResult<ActiveRegionRow>(reservation[1]);
    if (conflict) throw regionBusyError(conflict);
    const target = firstResult<{
      baseSequence: number;
      targetSequence: number;
      headRevisionId: string;
    }>(reservation[2]);
    if (!target || target.targetSequence >= target.baseSequence) {
      throw new DomainError("INVALID_REQUEST", "Choose an earlier revision to restore.");
    }
    throw new DomainError(
      "STALE_BASE_REVISION",
      "The artwork changed before the full-canvas restore could be reserved.",
    );
  }
  return getPublicJob(env, jobId);
}

export async function getPublicJob(env: AppEnv, jobId: string) {
  const row = await env.DB.prepare(
    `SELECT
       j.id AS id, j.kind AS kind, j.state AS state,
       result_revision_id AS resultRevisionId,
       error_code AS errorCode,
       public_error_message AS publicErrorMessage,
       j.region_x AS regionX,
       j.region_y AS regionY,
       j.region_width AS regionWidth,
       j.region_height AS regionHeight,
       j.lease_expires_at AS leaseExpiresAt,
       j.created_at AS createdAt,
       j.updated_at AS updatedAt,
       a.display_name AS author
     FROM edit_jobs j
     JOIN authors a ON a.id = j.author_id
     WHERE j.id = ? AND j.artwork_id = ?`,
  )
    .bind(jobId, ARTWORK_ID)
    .first<{
      id: string;
      kind: string;
      state: string;
      resultRevisionId: string | null;
      errorCode: string | null;
      publicErrorMessage: string | null;
      regionX: number | null;
      regionY: number | null;
      regionWidth: number | null;
      regionHeight: number | null;
      leaseExpiresAt: number | null;
      createdAt: number;
      updatedAt: number;
      author: string;
    }>();
  if (!row) throw new DomainError("NOT_FOUND", "That queue item could not be found.");
  const now = Date.now();
  const reservationActive =
    ["queued", "moderating", "generating", "committing"].includes(row.state) &&
    Number(row.leaseExpiresAt ?? 0) > now;
  const ahead =
    row.state === "queued" && reservationActive
      ? await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM edit_jobs
           WHERE artwork_id = ? AND state = 'queued'
             AND lease_expires_at > ? AND created_at < ?`,
        )
          .bind(ARTWORK_ID, now, row.createdAt)
          .first<{ count: number }>()
      : null;
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    author: row.author,
    region:
      row.regionX == null
        ? null
        : {
            x: Number(row.regionX),
            y: Number(row.regionY),
            width: Number(row.regionWidth),
            height: Number(row.regionHeight),
          },
    reservationActive,
    position:
      row.state === "queued" && reservationActive
        ? Number(ahead?.count ?? 0) + 1
        : null,
    resultRevisionId: row.resultRevisionId,
    message: publicJobMessage(row.state),
    error: row.errorCode
      ? { code: row.errorCode, message: row.publicErrorMessage }
      : null,
    submittedAt: new Date(Number(row.createdAt)).toISOString(),
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
  };
}
