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
  maskInGenerationFrame,
} from "./geometry.mjs";
import { isRetryableD1Reset, retryIdempotentD1 } from "./d1.mjs";
import { serializeRecentJobPayload } from "./activity.mjs";
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
  const existing = await runIdempotentD1(() =>
    env.DB.prepare("SELECT id FROM artworks WHERE id = ?")
      .bind(ARTWORK_ID)
      .first(),
  );
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

  await runIdempotentD1(() => env.DB.batch(statements));
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
      generationAvailable: Boolean(env.OPENAI_API_KEY?.trim()),
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

type RecentJobRow = ActiveRegionRow & {
  kind: string;
  prompt: string;
  errorCode: string | null;
  publicErrorMessage: string | null;
  startedAt: number | null;
  completedAt: number | null;
  retryable: number;
  requestId: string | null;
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

export const RECENT_JOBS_SQL = `SELECT
  j.id AS jobId,
  j.kind AS kind,
  a.display_name AS author,
  j.state AS state,
  j.prompt AS prompt,
  j.region_x AS regionX,
  j.region_y AS regionY,
  j.region_width AS regionWidth,
  j.region_height AS regionHeight,
  CASE
    WHEN j.state IN ('queued', 'moderating', 'generating', 'committing')
      AND j.lease_expires_at > ? THEN 1
    ELSE 0
  END AS reservationActive,
  j.error_code AS errorCode,
  j.public_error_message AS publicErrorMessage,
  j.created_at AS createdAt,
  j.updated_at AS updatedAt,
  j.started_at AS startedAt,
  j.completed_at AS completedAt,
  j.request_id AS requestId,
  CASE WHEN
    j.kind = 'edit'
    AND j.state = 'failed'
    AND (
      j.error_code IN (
        'PROVIDER_TEMPORARY',
        'SUBJECT_OUT_OF_FRAME',
        'REFERENCE_REVIEW_FAILED',
        'QUEUE_LEASE_EXPIRED'
      )
    )
    AND j.display_mask_blob_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM blobs display WHERE display.id = j.display_mask_blob_id)
    AND j.execution_mode = 'openai'
    AND j.source_blob_id IS NOT NULL
    AND j.mask_blob_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM blobs source WHERE source.id = j.source_blob_id)
    AND EXISTS (SELECT 1 FROM blobs mask WHERE mask.id = j.mask_blob_id)
    AND (
      j.reference_blob_id IS NULL
      OR EXISTS (SELECT 1 FROM blobs reference WHERE reference.id = j.reference_blob_id)
    )
    AND NOT EXISTS (SELECT 1 FROM edit_jobs retry WHERE retry.retry_of_job_id = j.id)
    THEN 1 ELSE 0
  END AS retryable
FROM edit_jobs j
JOIN authors a ON a.id = j.author_id
WHERE j.artwork_id = ?
  AND (
    j.state IN ('queued', 'moderating', 'generating', 'committing')
    OR j.id IN (
      SELECT terminal.id
      FROM edit_jobs terminal
      WHERE terminal.artwork_id = ?
        AND terminal.state IN ('succeeded', 'stale', 'rejected', 'failed')
      ORDER BY terminal.created_at DESC, terminal.id DESC
      LIMIT 24
    )
  )
ORDER BY j.created_at DESC, j.id DESC
`;

function serializeRecentJob(row: RecentJobRow) {
  return serializeRecentJobPayload(row);
}

export async function getActivity(env: AppEnv, requestUrl: string) {
  await ensurePalimpsest(env, requestUrl);
  const now = Date.now();
  const results = await runIdempotentD1(() => env.DB.batch([
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN state = 'queued' AND lease_expires_at > ? THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN state IN ('moderating','generating','committing') AND lease_expires_at > ? THEN 1 ELSE 0 END) AS active
       FROM edit_jobs WHERE artwork_id = ?`,
    )
      .bind(now, now, ARTWORK_ID),
    env.DB.prepare(ACTIVE_REGIONS_SQL).bind(now, ARTWORK_ID),
    env.DB.prepare(RECENT_JOBS_SQL).bind(now, ARTWORK_ID, ARTWORK_ID),
    env.DB.prepare(
      `${revisionSelect} WHERE r.artwork_id = ? ORDER BY r.sequence DESC LIMIT 8`,
    ).bind(ARTWORK_ID),
  ]));
  const counts = firstResult<{ queued: number | null; active: number | null }>(results[0]);
  const activeRegions = (results[1]?.results ?? []) as unknown as ActiveRegionRow[];
  const jobs = (results[2]?.results ?? []) as unknown as RecentJobRow[];
  const recent = (results[3]?.results ?? []) as unknown as RevisionRow[];
  return {
    queue: { queued: Number(counts?.queued ?? 0), active: Number(counts?.active ?? 0) },
    activeRegions: activeRegions.map(serializeActiveRegion),
    jobs: jobs.map(serializeRecentJob),
    recent: recent.map(serializeRevision),
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

export const VISITOR_INTERACTION_TYPES = [
  "guide_opened",
  "queue_opened",
  "history_opened",
  "contribution_opened",
  "patch_confirmed",
  "mask_confirmed",
  "reference_added",
] as const;

export type VisitorInteractionType = (typeof VISITOR_INTERACTION_TYPES)[number];
export type VisitorEventType = VisitorInteractionType | "page_view" | "generation_requested" | "restore_requested";

const VISITOR_EVENT_TYPES = new Set<VisitorEventType>([
  "page_view",
  "generation_requested",
  "restore_requested",
  ...VISITOR_INTERACTION_TYPES,
]);

type VisitorEventRow = {
  visitorHash: string;
  sessionId: string | null;
  eventType: VisitorEventType;
  path: string;
  country: string | null;
  userAgent: string | null;
  jobId: string | null;
  createdAt: number;
};

const VISITOR_EVENT_DEDUPE_MS = 5_000;
const VISITOR_EVENT_LIMIT = 120;
const VISITOR_EVENT_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const VISITOR_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function normalizedSessionId(value: string | null | undefined): string | null {
  if (!value || !/^[A-Za-z0-9_-]{20,128}$/u.test(value)) return null;
  return value;
}

function normalizedCountry(value: string | null): string | null {
  return value && /^[A-Z]{2}$/u.test(value) ? value : null;
}

function compactUserAgent(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/\s+/gu, " ").trim().slice(0, 320) || null;
}

async function visitorHash(env: AppEnv, request: Request): Promise<string> {
  const address = request.headers.get("CF-Connecting-IP") ?? "local-preview";
  const salt = env.VISITOR_LOG_SALT ?? env.RATE_LIMIT_SALT;
  if (!salt) {
    throw new DomainError(
      "SERVICE_UNAVAILABLE",
      "Visitor logging requires a configured VISITOR_LOG_SALT.",
    );
  }
  return sha256Hex(`${salt}:visitor:${address}`);
}

export function isVisitorInteractionType(value: unknown): value is VisitorInteractionType {
  return typeof value === "string" && VISITOR_INTERACTION_TYPES.includes(value as VisitorInteractionType);
}

export async function recordVisitorEvent(
  env: AppEnv,
  request: Request,
  eventType: VisitorEventType,
  options: { sessionId?: string | null; jobId?: string | null } = {},
) {
  if (!VISITOR_EVENT_TYPES.has(eventType)) {
    throw new DomainError("INVALID_REQUEST", "That visitor event is not supported.");
  }
  const url = new URL(request.url);
  const now = Date.now();
  const hash = await visitorHash(env, request);
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM visitor_events
     WHERE visitor_hash = ? AND created_at >= ?`,
  )
    .bind(hash, now - VISITOR_EVENT_LIMIT_WINDOW_MS)
    .first<{ count: number }>();
  if (Number(recent?.count ?? 0) >= VISITOR_EVENT_LIMIT) {
    throw new DomainError("RATE_LIMITED", "Too many visitor events. Try again later.");
  }
  await env.DB.prepare(
    `DELETE FROM visitor_events
     WHERE id IN (
       SELECT id FROM visitor_events
       WHERE created_at < ?
       ORDER BY created_at ASC
       LIMIT 250
     )`,
  )
    .bind(now - VISITOR_EVENT_RETENTION_MS)
    .run();
  await env.DB.prepare(
    `INSERT INTO visitor_events
      (id, visitor_hash, session_id, event_type, path, country, user_agent, job_id, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1
       FROM visitor_events
       WHERE visitor_hash = ?
         AND event_type = ?
         AND path = ?
         AND COALESCE(session_id, '') = COALESCE(?, '')
         AND created_at >= ?
     )`,
  )
    .bind(
      crypto.randomUUID(),
      hash,
      normalizedSessionId(options.sessionId),
      eventType,
      url.pathname,
      normalizedCountry(request.headers.get("CF-IPCountry")),
      compactUserAgent(request.headers.get("User-Agent")),
      options.jobId ?? null,
      now,
      hash,
      eventType,
      url.pathname,
      normalizedSessionId(options.sessionId),
      now - VISITOR_EVENT_DEDUPE_MS,
    )
    .run();
}

export async function getVisitorActivity(env: AppEnv, limit = 160) {
  const boundedLimit = Math.max(1, Math.min(250, Math.floor(limit)));
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const [summary, events] = await Promise.all([
    env.DB.prepare(
      `SELECT
        COUNT(DISTINCT visitor_hash) AS visitors,
        SUM(CASE WHEN event_type = 'page_view' THEN 1 ELSE 0 END) AS pageViews,
        SUM(CASE WHEN event_type = 'generation_requested' THEN 1 ELSE 0 END) AS generations,
        SUM(CASE WHEN event_type <> 'page_view' THEN 1 ELSE 0 END) AS interactions
       FROM visitor_events
       WHERE created_at >= ?`,
    )
      .bind(since)
      .first<{
        visitors: number | null;
        pageViews: number | null;
        generations: number | null;
        interactions: number | null;
      }>(),
    env.DB.prepare(
      `SELECT
        visitor_hash AS visitorHash,
        session_id AS sessionId,
        event_type AS eventType,
        path AS path,
        country AS country,
        user_agent AS userAgent,
        job_id AS jobId,
        created_at AS createdAt
       FROM visitor_events
       ORDER BY created_at DESC
       LIMIT ?`,
    )
      .bind(boundedLimit)
      .all<VisitorEventRow>(),
  ]);

  return {
    summary: {
      visitors: Number(summary?.visitors ?? 0),
      pageViews: Number(summary?.pageViews ?? 0),
      generations: Number(summary?.generations ?? 0),
      interactions: Number(summary?.interactions ?? 0),
    },
    events: events.results.map((event) => ({
      visitor: event.visitorHash.slice(0, 12),
      session: event.sessionId?.slice(0, 12) ?? null,
      type: event.eventType,
      path: event.path,
      country: event.country,
      userAgent: event.userAgent,
      jobId: event.jobId,
      createdAt: new Date(Number(event.createdAt)).toISOString(),
    })),
  };
}

type RecentReferenceUploadRow = {
  id: string;
  contentType: string;
  byteLength: number;
  width: number;
  height: number;
  createdAt: number;
};

export async function getRecentReferenceUploads(env: AppEnv, limit = 24) {
  const boundedLimit = Math.max(1, Math.min(48, Math.floor(limit)));
  const uploads = await env.DB.prepare(
    `SELECT
       id,
       content_type AS contentType,
       byte_length AS byteLength,
       width,
       height,
       created_at AS createdAt
     FROM blobs
     WHERE artwork_id = ? AND kind = 'reference'
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  )
    .bind(ARTWORK_ID, boundedLimit)
    .all<RecentReferenceUploadRow>();

  return uploads.results.map((upload) => ({
    id: upload.id,
    url: `/api/blobs/${encodeURIComponent(upload.id)}`,
    contentType: upload.contentType,
    byteLength: Number(upload.byteLength),
    width: Number(upload.width),
    height: Number(upload.height),
    createdAt: new Date(Number(upload.createdAt)).toISOString(),
  }));
}

export async function getDebugSnapshot(env: AppEnv, requestUrl: string) {
  const [activity, visitors, uploads] = await Promise.all([
    getActivity(env, requestUrl),
    getVisitorActivity(env),
    getRecentReferenceUploads(env),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    activity,
    visitors,
    uploads,
  };
}

export type ContributionRateLimit = {
  scope: string;
  limit: number;
  windowMs: number;
};

type PreparedRateLimit = ContributionRateLimit & { windowStart: number };

function prepareRateLimits(
  limits: readonly ContributionRateLimit[],
  expected: readonly ContributionRateLimit[],
  now: number,
): { enforced: number; values: PreparedRateLimit[] } {
  if (limits.length === 0) {
    return {
      enforced: 0,
      values: expected.map((limit) => ({
        ...limit,
        windowStart: Math.floor(now / limit.windowMs) * limit.windowMs,
      })),
    };
  }
  if (
    limits.length !== expected.length ||
    expected.some((rule) =>
      !limits.some(
        (limit) =>
          limit.scope === rule.scope &&
          limit.limit === rule.limit &&
          limit.windowMs === rule.windowMs,
      ),
    )
  ) {
    throw new DomainError("INTERNAL_ERROR", "The contribution rate policy is invalid.");
  }
  return {
    enforced: 1,
    values: expected.map((rule) => ({
      ...rule,
      windowStart: Math.floor(now / rule.windowMs) * rule.windowMs,
    })),
  };
}

const EDIT_RATE_RULES = [
  { scope: "edit-10m", limit: 3, windowMs: 10 * 60 * 1000 },
  { scope: "edit-day", limit: 12, windowMs: 24 * 60 * 60 * 1000 },
] as const;
const REVERT_RATE_RULES = [
  { scope: "revert-10m", limit: 2, windowMs: 10 * 60 * 1000 },
] as const;

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
  rateLimits: readonly ContributionRateLimit[];
  requestId: string;
  retryToken: string;
};

type ExistingIdempotencyRow = {
  id: string;
  requestFingerprint: string;
  state: string;
  availableAt: number;
  sourceBlobId: string | null;
  maskBlobId: string | null;
  displayMaskBlobId: string | null;
  referenceBlobId: string | null;
  retryTokenHash: string | null;
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

async function runIdempotentD1<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await retryIdempotentD1(operation);
  } catch (error) {
    if (isRetryableD1Reset(error)) {
      throw new DomainError(
        "SERVICE_UNAVAILABLE",
        "Palimpsest storage is briefly overloaded. Retry this same submission in a moment.",
      );
    }
    throw error;
  }
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
  idempotency_key, request_fingerprint, available_at, lease_expires_at, now_ms,
  retry_token_hash, request_id, rate_enforced,
  short_window_start, short_limit, daily_window_start, daily_limit
) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
INSERT OR IGNORE INTO edit_jobs (
  id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
  base_revision_id, prompt, region_x, region_y, region_width, region_height,
  frame_x, frame_y, frame_width, frame_height,
  source_blob_id, mask_blob_id, display_mask_blob_id, reference_blob_id,
  idempotency_key, request_fingerprint, retry_token_hash, request_id,
  available_at, lease_expires_at,
  created_at, updated_at
)
SELECT
  c.job_id, c.artwork_id, 'edit', 'queued', c.execution_mode, c.author_id,
  c.requester_hash, c.base_revision_id, c.prompt,
  c.region_x, c.region_y, c.region_width, c.region_height,
  c.frame_x, c.frame_y, c.frame_width, c.frame_height,
  c.source_blob_id, c.mask_blob_id, c.display_mask_blob_id, c.reference_blob_id,
  c.idempotency_key, c.request_fingerprint, c.retry_token_hash, c.request_id,
  c.available_at, c.lease_expires_at,
  c.now_ms, c.now_ms
FROM candidate c
WHERE EXISTS (
  SELECT 1 FROM revisions base
  WHERE base.artwork_id = c.artwork_id AND base.id = c.base_revision_id
)
AND (
  c.rate_enforced = 0 OR (
    (SELECT COUNT(*) FROM rate_limit_claims claim
     WHERE claim.requester_hash = c.requester_hash
       AND claim.scope = 'edit-10m'
       AND claim.window_start = c.short_window_start) < c.short_limit
    AND
    (SELECT COUNT(*) FROM rate_limit_claims claim
     WHERE claim.requester_hash = c.requester_hash
       AND claim.scope = 'edit-day'
       AND claim.window_start = c.daily_window_start) < c.daily_limit
  )
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
  available_at, lease_expires_at, now_ms, retry_token_hash, request_id,
  rate_enforced, rate_window_start, rate_limit
) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
INSERT OR IGNORE INTO edit_jobs (
  id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
  base_revision_id, target_revision_id, prompt,
  region_x, region_y, region_width, region_height,
  idempotency_key, request_fingerprint, retry_token_hash, request_id,
  available_at, lease_expires_at,
  created_at, updated_at
)
SELECT
  c.job_id, c.artwork_id, 'revert', 'queued', 'none', c.author_id,
  c.requester_hash, c.base_revision_id, c.target_revision_id, c.prompt,
  0, 0, 2048, 2048,
  c.idempotency_key, c.request_fingerprint, c.retry_token_hash, c.request_id,
  c.available_at, c.lease_expires_at,
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
)
AND (
  c.rate_enforced = 0 OR
  (SELECT COUNT(*) FROM rate_limit_claims claim
   WHERE claim.requester_hash = c.requester_hash
     AND claim.scope = 'revert-10m'
     AND claim.window_start = c.rate_window_start) < c.rate_limit
)`;

async function markPreparationFailed(
  env: AppEnv,
  jobId: string,
  code: string,
  message: string,
) {
  const now = Date.now();
  await runIdempotentD1(() =>
    env.DB.batch([
      env.DB.prepare(
        `UPDATE edit_jobs
         SET state = 'failed', error_code = ?, public_error_message = ?,
             lease_expires_at = NULL, updated_at = ?, completed_at = ?
         WHERE id = ? AND artwork_id = ? AND state = 'queued'
           AND available_at = ? AND worker_token IS NULL`,
      ).bind(code, message, now, now, jobId, ARTWORK_ID, PREPARING_AVAILABLE_AT),
      env.DB.prepare(
        `DELETE FROM rate_limit_claims
         WHERE job_id = ?
           AND EXISTS (
             SELECT 1 FROM edit_jobs
             WHERE id = ? AND state = 'failed' AND completed_at = ?
           )`,
      ).bind(jobId, jobId, now),
    ]),
  );
}

async function getIdempotentJob(
  env: AppEnv,
  idempotencyKey: string,
): Promise<ExistingIdempotencyRow | null> {
  return runIdempotentD1(() =>
    env.DB.prepare(
      `SELECT id, request_fingerprint AS requestFingerprint, state,
              available_at AS availableAt,
              source_blob_id AS sourceBlobId,
              mask_blob_id AS maskBlobId,
              display_mask_blob_id AS displayMaskBlobId,
              reference_blob_id AS referenceBlobId,
              retry_token_hash AS retryTokenHash
       FROM edit_jobs WHERE artwork_id = ? AND idempotency_key = ? LIMIT 1`,
    )
      .bind(ARTWORK_ID, idempotencyKey)
      .first<ExistingIdempotencyRow>(),
  );
}

export async function insertEditJob(env: AppEnv, input: InsertEditInput) {
  if (
    !(input.sourceBytes instanceof Uint8Array) ||
    !(input.maskBytes instanceof Uint8Array)
  ) {
    throw new DomainError(
      "INTERNAL_ERROR",
      "The edit reservation received an invalid immutable input set.",
    );
  }

  const frame = generationFrameForRegion(input.region);
  const executionMode = "openai";
  const normalizedMeta = JSON.stringify({
    baseRevisionId: input.baseRevisionId,
    prompt: input.prompt,
    region: input.region,
    frame,
    fill: input.fill,
    strokes: input.strokes,
    executionMode,
  });
  const [sourceHash, maskHash, referenceHash] = await Promise.all([
    sha256Hex(input.sourceBytes),
    sha256Hex(input.maskBytes),
    input.referenceBytes
      ? sha256Hex(input.referenceBytes)
      : Promise.resolve(null),
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
  const rate = prepareRateLimits(input.rateLimits, EDIT_RATE_RULES, now);
  const [shortRate, dailyRate] = rate.values;
  const retryTokenHash = await sha256Hex(input.retryToken);
  const generationMask = maskInGenerationFrame(
    input.region,
    input.strokes,
    frame,
  );
  const displayMask = new TextEncoder().encode(
    createDisplayMaskSvg({
      region: generationMask.region,
      fill: input.fill,
      strokes: generationMask.strokes,
    }),
  );
  const displayMaskHash = await sha256Hex(displayMask);

  const reservation = await runIdempotentD1(() => env.DB.batch([
    env.DB.prepare(
      `SELECT id, request_fingerprint AS requestFingerprint, state,
              available_at AS availableAt,
              source_blob_id AS sourceBlobId,
              mask_blob_id AS maskBlobId,
              display_mask_blob_id AS displayMaskBlobId,
              reference_blob_id AS referenceBlobId,
              retry_token_hash AS retryTokenHash
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
      `SELECT CASE WHEN ? = 0 OR (
         (SELECT COUNT(*) FROM rate_limit_claims
          WHERE requester_hash = ? AND scope = 'edit-10m' AND window_start = ?) < ?
         AND
         (SELECT COUNT(*) FROM rate_limit_claims
          WHERE requester_hash = ? AND scope = 'edit-day' AND window_start = ?) < ?
       ) THEN 1 ELSE 0 END AS allowed`,
    ).bind(
      rate.enforced,
      input.requesterHash,
      shortRate.windowStart,
      shortRate.limit,
      input.requesterHash,
      dailyRate.windowStart,
      dailyRate.limit,
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, display_name, source, created_at) VALUES (?, ?, 'visitor', ?)",
    ).bind(authorId, input.displayName, now),
    env.DB.prepare(INSERT_EDIT_RESERVATION_SQL).bind(
      jobId,
      ARTWORK_ID,
      executionMode,
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
      retryTokenHash,
      input.requestId,
      rate.enforced,
      shortRate.windowStart,
      shortRate.limit,
      dailyRate.windowStart,
      dailyRate.limit,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO rate_limit_claims
       (requester_hash, scope, window_start, idempotency_key, job_id, created_at)
       SELECT ?, 'edit-10m', ?, ?, ?, ?
       WHERE ? = 1 AND EXISTS (SELECT 1 FROM edit_jobs WHERE id = ?)`,
    ).bind(
      input.requesterHash,
      shortRate.windowStart,
      input.idempotencyKey,
      jobId,
      now,
      rate.enforced,
      jobId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO rate_limit_claims
       (requester_hash, scope, window_start, idempotency_key, job_id, created_at)
       SELECT ?, 'edit-day', ?, ?, ?, ?
       WHERE ? = 1 AND EXISTS (SELECT 1 FROM edit_jobs WHERE id = ?)`,
    ).bind(
      input.requesterHash,
      dailyRate.windowStart,
      input.idempotencyKey,
      jobId,
      now,
      rate.enforced,
      jobId,
    ),
    env.DB.prepare(
      `DELETE FROM authors
       WHERE id = ? AND NOT EXISTS (SELECT 1 FROM edit_jobs WHERE id = ?)`,
    ).bind(authorId, jobId),
  ]));

  let selected = firstResult<ExistingIdempotencyRow>(reservation[0]);
  const inserted = Number(reservation[6]?.meta.changes ?? 0) === 1;
  if (!selected && !inserted) {
    selected = await getIdempotentJob(env, input.idempotencyKey);
  }
  if (selected && selected.requestFingerprint !== fingerprint) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "That submission key was already used for a different edit.",
    );
  }

  if (!selected && !inserted) {
    if (!Boolean(firstResult<{ allowed: number }>(reservation[4])?.allowed)) {
      throw new DomainError(
        "RATE_LIMITED",
        "Too many contributions from this connection. Try again later.",
      );
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

  selected ??= {
    id: jobId,
    requestFingerprint: fingerprint,
    state: "queued",
    availableAt: PREPARING_AVAILABLE_AT,
    sourceBlobId,
    maskBlobId,
    displayMaskBlobId,
    referenceBlobId,
    retryTokenHash,
  };
  const selectedRetryToken =
    selected.retryTokenHash === retryTokenHash
      ? input.retryToken
      : null;
  if (selected.state !== "queued" || selected.availableAt !== PREPARING_AVAILABLE_AT) {
    const publicJob = await getPublicJob(env, selected.id);
    return selectedRetryToken ? { ...publicJob, retryToken: selectedRetryToken } : publicJob;
  }
  if (
    !selected.displayMaskBlobId ||
    !selected.sourceBlobId ||
    !selected.maskBlobId ||
    (Boolean(input.referenceBytes) !== Boolean(selected.referenceBlobId))
  ) {
    throw new DomainError(
      "INTERNAL_ERROR",
      "The reserved edit is missing its immutable input identifiers.",
    );
  }
  const selectedJobId = selected.id;
  const selectedSourceBlobId = selected.sourceBlobId;
  const selectedMaskBlobId = selected.maskBlobId;
  const selectedDisplayMaskBlobId = selected.displayMaskBlobId;
  const selectedReferenceBlobId = selected.referenceBlobId;
  const sourceKey =
    `artworks/palimpsest/inputs/${selectedJobId}/source-${sourceHash}.png`;
  const maskKey =
    `artworks/palimpsest/masks/${selectedJobId}/provider-${maskHash}.png`;
  const displayMaskKey = `artworks/palimpsest/masks/${selectedJobId}/display-${displayMaskHash}.svg`;
  const referenceKey = referenceHash
    ? `artworks/palimpsest/inputs/${selectedJobId}/reference-${referenceHash}.png`
    : null;

  const blobWrites: Array<Promise<R2Object | null>> = [];
  blobWrites.push(
    env.BLOBS.put(sourceKey, input.sourceBytes, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { sha256: sourceHash, private: "true" },
    }),
    env.BLOBS.put(maskKey, input.maskBytes, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { sha256: maskHash, private: "true" },
    }),
  );
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
      selectedJobId,
      "STORAGE_WRITE_FAILED",
      "The edit inputs could not be stored safely. Nothing was added to history.",
    );
    throw error;
  }

  const readyAt = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (selectedSourceBlobId && selectedMaskBlobId) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO blobs
         (id, artwork_id, kind, r2_key, content_type, byte_length, sha256, width, height, created_at)
         VALUES (?, ?, 'input', ?, 'image/png', ?, ?, 1024, 1024, ?)`,
      ).bind(
        selectedSourceBlobId,
        ARTWORK_ID,
        sourceKey,
        input.sourceBytes.byteLength,
        sourceHash,
        now,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO blobs
         (id, artwork_id, kind, r2_key, content_type, byte_length, sha256, width, height, created_at)
         VALUES (?, ?, 'mask', ?, 'image/png', ?, ?, 1024, 1024, ?)`,
      ).bind(
        selectedMaskBlobId,
        ARTWORK_ID,
        maskKey,
        input.maskBytes.byteLength,
        maskHash,
        now,
      ),
    );
  }
  if (
    input.referenceBytes &&
    selectedReferenceBlobId &&
    referenceHash &&
    referenceKey
  ) {
    statements.push(
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO blobs
           (id, artwork_id, kind, r2_key, content_type, byte_length, sha256, width, height, created_at)
           VALUES (?, ?, 'input', ?, 'image/png', ?, ?, 1024, 1024, ?)`,
        )
        .bind(
          selectedReferenceBlobId,
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
        `INSERT OR IGNORE INTO blobs
         (id, artwork_id, kind, r2_key, content_type, byte_length, sha256, width, height, created_at)
         VALUES (?, ?, 'display_mask', ?, 'image/svg+xml', ?, ?, 1024, 1024, ?)`,
      )
      .bind(
        selectedDisplayMaskBlobId,
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
      selectedJobId,
      ARTWORK_ID,
      readyAt,
      readyAt,
    ),
  );
  try {
    const metadata = await runIdempotentD1(() => env.DB.batch(statements));
    if (Number(metadata.at(-1)?.meta.changes ?? 0) !== 1) {
      const current = await getIdempotentJob(env, input.idempotencyKey);
      if (
        current &&
        (current.state !== "queued" || current.availableAt !== PREPARING_AVAILABLE_AT)
      ) {
        const publicJob = await getPublicJob(env, current.id);
        return selectedRetryToken
          ? { ...publicJob, retryToken: selectedRetryToken }
          : publicJob;
      }
      await markPreparationFailed(
        env,
        selectedJobId,
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
      if (conflict && conflict.jobId !== selectedJobId) throw regionBusyError(conflict);
      throw new DomainError(
        "QUEUE_LEASE_EXPIRED",
        "The edit reservation expired before the upload became ready.",
      );
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    await markPreparationFailed(
      env,
      selectedJobId,
      "STORAGE_METADATA_FAILED",
      "The edit inputs could not be recorded safely. Nothing was added to history.",
    );
    throw error;
  }

  const publicJob = await getPublicJob(env, selectedJobId);
  return selectedRetryToken ? { ...publicJob, retryToken: selectedRetryToken } : publicJob;
}

export async function insertRevertJob(
  env: AppEnv,
  input: {
    baseRevisionId: string;
    targetRevisionId: string;
    displayName: string;
    requesterHash: string;
    idempotencyKey: string;
    rateLimits: readonly ContributionRateLimit[];
    requestId: string;
  },
) {
  const targetRevision = await runIdempotentD1(() =>
    env.DB.prepare(
      "SELECT sequence FROM revisions WHERE artwork_id = ? AND id = ? LIMIT 1",
    )
      .bind(ARTWORK_ID, input.targetRevisionId)
      .first<{ sequence: number }>(),
  );
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
  const rate = prepareRateLimits(input.rateLimits, REVERT_RATE_RULES, now);
  const [revertRate] = rate.values;
  const reservation = await runIdempotentD1(() => env.DB.batch([
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
      `SELECT CASE WHEN ? = 0 OR (
         SELECT COUNT(*) FROM rate_limit_claims
         WHERE requester_hash = ? AND scope = 'revert-10m' AND window_start = ?
       ) < ? THEN 1 ELSE 0 END AS allowed`,
    ).bind(
      rate.enforced,
      input.requesterHash,
      revertRate.windowStart,
      revertRate.limit,
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, display_name, source, created_at) VALUES (?, ?, 'visitor', ?)",
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
      null,
      input.requestId,
      rate.enforced,
      revertRate.windowStart,
      revertRate.limit,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO rate_limit_claims
       (requester_hash, scope, window_start, idempotency_key, job_id, created_at)
       SELECT ?, 'revert-10m', ?, ?, ?, ?
       WHERE ? = 1 AND EXISTS (SELECT 1 FROM edit_jobs WHERE id = ?)`,
    ).bind(
      input.requesterHash,
      revertRate.windowStart,
      input.idempotencyKey,
      jobId,
      now,
      rate.enforced,
      jobId,
    ),
    env.DB.prepare(
      `DELETE FROM authors
       WHERE id = ? AND NOT EXISTS (SELECT 1 FROM edit_jobs WHERE id = ?)`,
    ).bind(authorId, jobId),
  ]));

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

  if (Number(reservation[5]?.meta.changes ?? 0) === 0) {
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
    if (!Boolean(firstResult<{ allowed: number }>(reservation[3])?.allowed)) {
      throw new DomainError(
        "RATE_LIMITED",
        "Too many contributions from this connection. Try again later.",
      );
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

type RetryCandidateRow = {
  id: string;
  state: string;
  executionMode: "openai" | "placement" | "none";
  referenceBlobId: string | null;
  errorCode: string | null;
  sourceKey: string | null;
  maskKey: string | null;
  displayMaskKey: string | null;
  referenceKey: string | null;
  successorId: string | null;
};

export const INSERT_RETRY_JOB_SQL = `WITH candidate(
  job_id, parent_job_id, artwork_id, requester_hash, retry_token_hash,
  idempotency_key, request_id, now_ms, lease_expires_at,
  rate_enforced, short_window_start, short_limit, daily_window_start, daily_limit
) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
INSERT OR IGNORE INTO edit_jobs (
  id, artwork_id, kind, state, execution_mode, author_id, requester_hash,
  base_revision_id, target_revision_id, prompt,
  region_x, region_y, region_width, region_height,
  frame_x, frame_y, frame_width, frame_height,
  source_blob_id, mask_blob_id, display_mask_blob_id, reference_blob_id,
  idempotency_key, request_fingerprint, retry_of_job_id, retry_token_hash,
  request_id, attempt_count, available_at, lease_fence, lease_expires_at,
  created_at, updated_at
)
SELECT
  c.job_id, parent.artwork_id, parent.kind, 'queued', parent.execution_mode,
  parent.author_id, parent.requester_hash, parent.base_revision_id,
  parent.target_revision_id, parent.prompt,
  parent.region_x, parent.region_y, parent.region_width, parent.region_height,
  parent.frame_x, parent.frame_y, parent.frame_width, parent.frame_height,
  parent.source_blob_id, parent.mask_blob_id, parent.display_mask_blob_id,
  parent.reference_blob_id, c.idempotency_key, parent.request_fingerprint,
  parent.id, parent.retry_token_hash, c.request_id, 0, c.now_ms, 0,
  c.lease_expires_at, c.now_ms, c.now_ms
FROM candidate c
JOIN edit_jobs parent ON parent.id = c.parent_job_id
WHERE parent.artwork_id = c.artwork_id
  AND parent.kind = 'edit'
  AND parent.state = 'failed'
  AND parent.requester_hash = c.requester_hash
  AND parent.retry_token_hash = c.retry_token_hash
  AND (
    parent.error_code IN (
      'PROVIDER_TEMPORARY',
      'SUBJECT_OUT_OF_FRAME',
      'REFERENCE_REVIEW_FAILED',
      'QUEUE_LEASE_EXPIRED'
    )
  )
  AND parent.display_mask_blob_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM blobs display WHERE display.id = parent.display_mask_blob_id)
  AND parent.execution_mode = 'openai'
  AND parent.source_blob_id IS NOT NULL
  AND parent.mask_blob_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM blobs source WHERE source.id = parent.source_blob_id)
  AND EXISTS (SELECT 1 FROM blobs mask WHERE mask.id = parent.mask_blob_id)
  AND (
    parent.reference_blob_id IS NULL
    OR EXISTS (
      SELECT 1 FROM blobs reference WHERE reference.id = parent.reference_blob_id
    )
  )
  AND EXISTS (
    SELECT 1 FROM revisions base
    WHERE base.artwork_id = parent.artwork_id AND base.id = parent.base_revision_id
  )
  AND NOT EXISTS (SELECT 1 FROM edit_jobs child WHERE child.retry_of_job_id = parent.id)
  AND NOT EXISTS (
    SELECT 1 FROM edit_jobs active
    WHERE active.artwork_id = parent.artwork_id
      AND active.state IN ('queued', 'moderating', 'generating', 'committing')
      AND active.lease_expires_at > c.now_ms
      AND active.region_x < parent.region_x + parent.region_width
      AND active.region_x + active.region_width > parent.region_x
      AND active.region_y < parent.region_y + parent.region_height
      AND active.region_y + active.region_height > parent.region_y
  )
  AND NOT EXISTS (
    SELECT 1
    FROM revisions base
    JOIN revisions accepted
      ON accepted.artwork_id = base.artwork_id
     AND accepted.sequence > base.sequence
    WHERE base.artwork_id = parent.artwork_id
      AND base.id = parent.base_revision_id
      AND accepted.region_x IS NOT NULL
      AND accepted.region_x < parent.region_x + parent.region_width
      AND accepted.region_x + accepted.region_width > parent.region_x
      AND accepted.region_y < parent.region_y + parent.region_height
      AND accepted.region_y + accepted.region_height > parent.region_y
  )
  AND (
    c.rate_enforced = 0 OR (
      (SELECT COUNT(*) FROM rate_limit_claims claim
       WHERE claim.requester_hash = c.requester_hash
         AND claim.scope = 'edit-10m'
         AND claim.window_start = c.short_window_start) < c.short_limit
      AND
      (SELECT COUNT(*) FROM rate_limit_claims claim
       WHERE claim.requester_hash = c.requester_hash
         AND claim.scope = 'edit-day'
         AND claim.window_start = c.daily_window_start) < c.daily_limit
    )
  )`;

export async function retryFailedEditJob(
  env: AppEnv,
  input: {
    jobId: string;
    requesterHash: string;
    retryToken: string;
    idempotencyKey: string;
    rateLimits: readonly ContributionRateLimit[];
    requestId: string;
  },
) {
  const retryTokenHash = await sha256Hex(input.retryToken);
  const candidate = await runIdempotentD1(() =>
    env.DB.prepare(
      `SELECT j.id, j.state, j.execution_mode AS executionMode,
              j.reference_blob_id AS referenceBlobId,
              j.error_code AS errorCode,
              source.r2_key AS sourceKey, mask.r2_key AS maskKey,
              display.r2_key AS displayMaskKey, reference.r2_key AS referenceKey,
              (SELECT child.id FROM edit_jobs child
               WHERE child.retry_of_job_id = j.id LIMIT 1) AS successorId
       FROM edit_jobs j
       LEFT JOIN blobs source ON source.id = j.source_blob_id
       LEFT JOIN blobs mask ON mask.id = j.mask_blob_id
       LEFT JOIN blobs display ON display.id = j.display_mask_blob_id
       LEFT JOIN blobs reference ON reference.id = j.reference_blob_id
       WHERE j.id = ? AND j.artwork_id = ? AND j.kind = 'edit'
         AND j.requester_hash = ? AND j.retry_token_hash = ?`,
    )
      .bind(input.jobId, ARTWORK_ID, input.requesterHash, retryTokenHash)
      .first<RetryCandidateRow>(),
  );
  if (!candidate) {
    throw new DomainError("NOT_FOUND", "That retryable contribution could not be found.");
  }
  const hasCanonicalInputShape = candidate.executionMode === "openai";
  if (!hasCanonicalInputShape) {
    throw new DomainError(
      "JOB_NOT_RETRYABLE",
      "This attempt used a retired contribution format. Submit a new contribution instead.",
    );
  }
  if (candidate.successorId) {
    return { ...(await getPublicJob(env, candidate.successorId)), retryToken: input.retryToken };
  }
  const technicallyRetryable =
    candidate.state === "failed" &&
    ([
      "PROVIDER_TEMPORARY",
      "SUBJECT_OUT_OF_FRAME",
      "REFERENCE_REVIEW_FAILED",
      "QUEUE_LEASE_EXPIRED",
    ].includes(candidate.errorCode ?? ""));
  const requiredKeys =
    candidate.executionMode === "openai"
      ? [
          candidate.sourceKey,
          candidate.maskKey,
          candidate.displayMaskKey,
          ...(candidate.referenceBlobId ? [candidate.referenceKey] : []),
        ]
      : [];
  if (
    !technicallyRetryable ||
    requiredKeys.length === 0 ||
    requiredKeys.some((key) => typeof key !== "string")
  ) {
    throw new DomainError(
      "JOB_NOT_RETRYABLE",
      "This attempt cannot be retried safely. Submit a new contribution instead.",
    );
  }
  const objects = await Promise.all(
    requiredKeys.map((key) => env.BLOBS.head(key as string)),
  );
  if (objects.some((object) => object == null)) {
    throw new DomainError(
      "JOB_NOT_RETRYABLE",
      "The original edit inputs are no longer available. Submit a new contribution instead.",
    );
  }

  const now = Date.now();
  const rate = prepareRateLimits(input.rateLimits, EDIT_RATE_RULES, now);
  const [shortRate, dailyRate] = rate.values;
  const successorId = crypto.randomUUID();
  const successorKey = input.idempotencyKey;
  const results = await runIdempotentD1(() =>
    env.DB.batch([
      env.DB.prepare(
        "SELECT id FROM edit_jobs WHERE retry_of_job_id = ? LIMIT 1",
      ).bind(input.jobId),
      env.DB.prepare(
        `SELECT CASE WHEN ? = 0 OR (
           (SELECT COUNT(*) FROM rate_limit_claims
            WHERE requester_hash = ? AND scope = 'edit-10m' AND window_start = ?) < ?
           AND
           (SELECT COUNT(*) FROM rate_limit_claims
            WHERE requester_hash = ? AND scope = 'edit-day' AND window_start = ?) < ?
         ) THEN 1 ELSE 0 END AS allowed`,
      ).bind(
        rate.enforced,
        input.requesterHash,
        shortRate.windowStart,
        shortRate.limit,
        input.requesterHash,
        dailyRate.windowStart,
        dailyRate.limit,
      ),
      env.DB.prepare(INSERT_RETRY_JOB_SQL).bind(
        successorId,
        input.jobId,
        ARTWORK_ID,
        input.requesterHash,
        retryTokenHash,
        successorKey,
        input.requestId,
        now,
        now + RESERVATION_LEASE_MS,
        rate.enforced,
        shortRate.windowStart,
        shortRate.limit,
        dailyRate.windowStart,
        dailyRate.limit,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO rate_limit_claims
         (requester_hash, scope, window_start, idempotency_key, job_id, created_at)
         SELECT ?, 'edit-10m', ?, ?, ?, ?
         WHERE ? = 1 AND EXISTS (SELECT 1 FROM edit_jobs WHERE id = ?)`,
      ).bind(
        input.requesterHash,
        shortRate.windowStart,
        successorKey,
        successorId,
        now,
        rate.enforced,
        successorId,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO rate_limit_claims
         (requester_hash, scope, window_start, idempotency_key, job_id, created_at)
         SELECT ?, 'edit-day', ?, ?, ?, ?
         WHERE ? = 1 AND EXISTS (SELECT 1 FROM edit_jobs WHERE id = ?)`,
      ).bind(
        input.requesterHash,
        dailyRate.windowStart,
        successorKey,
        successorId,
        now,
        rate.enforced,
        successorId,
      ),
    ]),
  );
  let resolvedId = firstResult<{ id: string }>(results[0])?.id ?? null;
  if (!resolvedId && Number(results[2]?.meta.changes ?? 0) === 1) {
    resolvedId = successorId;
  }
  if (!resolvedId) {
    resolvedId = (
      await runIdempotentD1(() =>
        env.DB.prepare("SELECT id FROM edit_jobs WHERE retry_of_job_id = ? LIMIT 1")
          .bind(input.jobId)
          .first<{ id: string }>(),
      )
    )?.id ?? null;
  }
  if (!resolvedId) {
    if (!Boolean(firstResult<{ allowed: number }>(results[1])?.allowed)) {
      throw new DomainError(
        "RATE_LIMITED",
        "Too many contributions from this connection. Try again later.",
      );
    }
    throw new DomainError(
      "JOB_NOT_RETRYABLE",
      "The original region is no longer safe to retry. Submit against the latest canvas instead.",
    );
  }
  return { ...(await getPublicJob(env, resolvedId)), retryToken: input.retryToken };
}

export async function getPublicJob(env: AppEnv, jobId: string) {
  const now = Date.now();
  const row = await runIdempotentD1(() => env.DB.prepare(
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
       j.started_at AS startedAt,
       j.completed_at AS completedAt,
       j.request_id AS requestId,
       CASE WHEN j.state = 'queued' AND j.lease_expires_at > ? THEN 1 + (
         SELECT COUNT(*) FROM edit_jobs ahead
         WHERE ahead.artwork_id = j.artwork_id AND ahead.state = 'queued'
           AND ahead.lease_expires_at > ? AND ahead.created_at < j.created_at
       ) ELSE NULL END AS position,
       CASE WHEN
         j.kind = 'edit' AND j.state = 'failed'
         AND (
           j.error_code IN (
             'PROVIDER_TEMPORARY',
             'SUBJECT_OUT_OF_FRAME',
             'REFERENCE_REVIEW_FAILED',
             'QUEUE_LEASE_EXPIRED'
           )
         )
         AND j.display_mask_blob_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM blobs display WHERE display.id = j.display_mask_blob_id)
         AND j.execution_mode = 'openai'
         AND j.source_blob_id IS NOT NULL
         AND j.mask_blob_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM blobs source WHERE source.id = j.source_blob_id)
         AND EXISTS (SELECT 1 FROM blobs mask WHERE mask.id = j.mask_blob_id)
         AND (
           j.reference_blob_id IS NULL
           OR EXISTS (
             SELECT 1 FROM blobs reference WHERE reference.id = j.reference_blob_id
           )
         )
         AND NOT EXISTS (SELECT 1 FROM edit_jobs retry WHERE retry.retry_of_job_id = j.id)
         THEN 1 ELSE 0
       END AS retryable,
       a.display_name AS author
     FROM edit_jobs j
     JOIN authors a ON a.id = j.author_id
     WHERE j.id = ? AND j.artwork_id = ?`,
  )
    .bind(now, now, jobId, ARTWORK_ID)
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
      startedAt: number | null;
      completedAt: number | null;
      requestId: string | null;
      retryable: number;
      position: number | null;
      author: string;
    }>());
  if (!row) throw new DomainError("NOT_FOUND", "That queue item could not be found.");
  const reservationActive =
    ["queued", "moderating", "generating", "committing"].includes(row.state) &&
    Number(row.leaseExpiresAt ?? 0) > now;
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
        ? Number(row.position ?? 1)
        : null,
    resultRevisionId: row.resultRevisionId,
    message: publicJobMessage(row.state),
    error: row.errorCode
      ? { code: row.errorCode, message: row.publicErrorMessage }
      : null,
    requestId: row.requestId,
    retryable: Boolean(row.retryable),
    submittedAt: new Date(Number(row.createdAt)).toISOString(),
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
    startedAt: row.startedAt == null ? null : new Date(Number(row.startedAt)).toISOString(),
    completedAt:
      row.completedAt == null ? null : new Date(Number(row.completedAt)).toISOString(),
  };
}
