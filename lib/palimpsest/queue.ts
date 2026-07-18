import {
  ARTWORK_ID,
  DomainError,
  assertFreshBase,
  buildOpenAiEditPrompt,
} from "./domain.mjs";
import type { AppEnv } from "./runtime";
import { readPngDimensions, sha256Hex } from "./runtime";
import { getBlobRecord, getHead, makeDemoPatchSvg } from "./store";

type QueueJob = {
  id: string;
  kind: "edit" | "revert";
  state: string;
  executionMode: "demo" | "openai" | "none";
  authorId: string;
  baseRevisionId: string;
  targetRevisionId: string | null;
  prompt: string;
  tileX: number | null;
  tileY: number | null;
  regionX: number | null;
  regionY: number | null;
  regionWidth: number | null;
  regionHeight: number | null;
  sourceBlobId: string | null;
  maskBlobId: string | null;
  displayMaskBlobId: string | null;
  attemptCount: number;
  availableAt: number;
  createdAt: number;
};

const leaseMs = 4 * 60 * 1000;
const abandonedAfterMs = 3 * 60 * 1000;

export async function processQueue(env: AppEnv, maxJobs = 1): Promise<void> {
  for (let processed = 0; processed < maxJobs; processed += 1) {
    const didProcess = await processOne(env);
    if (!didProcess) return;
  }
}

async function processOne(env: AppEnv): Promise<boolean> {
  const ownerToken = crypto.randomUUID();
  const now = Date.now();
  const acquired = await env.DB.prepare(
    `UPDATE queue_locks
     SET state = 'held', owner_token = ?, fence = fence + 1,
         job_id = NULL, acquired_at = ?, heartbeat_at = ?, lease_expires_at = ?
     WHERE artwork_id = ? AND (
       state = 'idle' OR lease_expires_at IS NULL OR lease_expires_at < ? OR heartbeat_at < ?
     )`,
  )
    .bind(ownerToken, now, now, now + leaseMs, ARTWORK_ID, now, now - abandonedAfterMs)
    .run();
  if (Number(acquired.meta.changes ?? 0) === 0) return false;

  const lock = await env.DB.prepare(
    "SELECT fence FROM queue_locks WHERE artwork_id = ? AND owner_token = ?",
  )
    .bind(ARTWORK_ID, ownerToken)
    .first<{ fence: number }>();
  if (!lock) return false;
  const fence = Number(lock.fence);

  await recoverAbandonedJobs(env, now);

  const job = await env.DB.prepare(
    `SELECT
       id,
       kind,
       state,
       execution_mode AS executionMode,
       author_id AS authorId,
       base_revision_id AS baseRevisionId,
       target_revision_id AS targetRevisionId,
       prompt,
       tile_x AS tileX,
       tile_y AS tileY,
       region_x AS regionX,
       region_y AS regionY,
       region_width AS regionWidth,
       region_height AS regionHeight,
       source_blob_id AS sourceBlobId,
       mask_blob_id AS maskBlobId,
       display_mask_blob_id AS displayMaskBlobId,
       attempt_count AS attemptCount,
       available_at AS availableAt,
       created_at AS createdAt
     FROM edit_jobs
     WHERE artwork_id = ? AND state = 'queued'
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
  )
    .bind(ARTWORK_ID)
    .first<QueueJob>();

  if (!job || Number(job.availableAt) > now) {
    await releaseLock(env, ownerToken, fence);
    return false;
  }

  const firstState =
    job.kind === "revert"
      ? "committing"
      : job.executionMode === "openai"
        ? "moderating"
        : "generating";
  const claimed = await env.DB.prepare(
    `UPDATE edit_jobs
     SET state = ?, worker_token = ?, lock_fence = ?, lease_expires_at = ?,
         started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE id = ? AND state = 'queued'`,
  )
    .bind(firstState, ownerToken, fence, now + leaseMs, now, now, job.id)
    .run();
  if (Number(claimed.meta.changes ?? 0) === 0) {
    await releaseLock(env, ownerToken, fence);
    return false;
  }
  await env.DB.prepare(
    "UPDATE queue_locks SET job_id = ? WHERE artwork_id = ? AND owner_token = ? AND fence = ?",
  )
    .bind(job.id, ARTWORK_ID, ownerToken, fence)
    .run();

  try {
    const head = await getHead(env);
    assertFreshBase(job.baseRevisionId, head.id);

    if (job.kind === "revert") {
      await commitRevert(env, job, ownerToken, fence, head.sequence + 1);
      return true;
    }

    if (
      job.tileX == null ||
      job.tileY == null ||
      job.regionX == null ||
      job.regionY == null ||
      job.regionWidth == null ||
      job.regionHeight == null ||
      !job.displayMaskBlobId
    ) {
      throw new DomainError("INTERNAL_ERROR", "The queued edit is incomplete.");
    }

    let patch: { bytes: Uint8Array; contentType: string; providerRequestId?: string };
    if (job.executionMode === "openai") {
      if (!env.OPENAI_API_KEY) {
        throw new DomainError(
          "AI_CONFIGURATION_ERROR",
          "Live image editing is not configured. Nothing was added to history.",
        );
      }
      await moderatePrompt(env.OPENAI_API_KEY, job.prompt);
      await updateStage(env, job.id, ownerToken, fence, "generating");
      patch = await generateOpenAiPatch(env, job, env.OPENAI_API_KEY);
    } else {
      const maskRecord = await getBlobRecord(env, job.displayMaskBlobId);
      const seed = await sha256Hex(
        `${ARTWORK_ID}:${job.baseRevisionId}:${job.prompt}:${maskRecord?.sha256 ?? "mask"}`,
      );
      const svg = makeDemoPatchSvg(
        job.prompt,
        {
          x: job.regionX,
          y: job.regionY,
          width: job.regionWidth,
          height: job.regionHeight,
        },
        seed,
      );
      patch = {
        bytes: new TextEncoder().encode(svg),
        contentType: "image/svg+xml",
      };
    }

    await updateStage(env, job.id, ownerToken, fence, "committing");
    await commitPatch(env, job, patch, ownerToken, fence, head.sequence + 1);
    return true;
  } catch (error) {
    await handleFailure(env, job, ownerToken, fence, error);
    return true;
  }
}

async function recoverAbandonedJobs(env: AppEnv, now: number) {
  const staleBefore = now - abandonedAfterMs;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE edit_jobs
       SET state = 'failed', error_code = 'QUEUE_LEASE_EXPIRED',
           public_error_message = 'The queue could not safely resume this edit. Nothing was added to history.',
           worker_token = NULL, lock_fence = NULL, lease_expires_at = NULL,
           updated_at = ?, completed_at = ?
       WHERE artwork_id = ?
         AND state IN ('moderating', 'generating', 'committing')
         AND updated_at < ? AND attempt_count >= 2`,
    ).bind(now, now, ARTWORK_ID, staleBefore),
    env.DB.prepare(
      `UPDATE edit_jobs
       SET state = 'queued', attempt_count = attempt_count + 1, available_at = ?,
           worker_token = NULL, lock_fence = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE artwork_id = ?
         AND state IN ('moderating', 'generating', 'committing')
         AND updated_at < ? AND attempt_count < 2`,
    ).bind(now, now, ARTWORK_ID, staleBefore),
  ]);
}

async function updateStage(
  env: AppEnv,
  jobId: string,
  ownerToken: string,
  fence: number,
  state: string,
) {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE edit_jobs SET state = ?, updated_at = ?, lease_expires_at = ?
     WHERE id = ? AND worker_token = ? AND lock_fence = ?`,
  )
    .bind(state, now, now + leaseMs, jobId, ownerToken, fence)
    .run();
  if (Number(result.meta.changes ?? 0) === 0) {
    throw new DomainError("STALE_BASE_REVISION", "The queue lease expired before the edit could commit.");
  }
  await env.DB.prepare(
    `UPDATE queue_locks SET heartbeat_at = ?, lease_expires_at = ?
     WHERE artwork_id = ? AND owner_token = ? AND fence = ?`,
  )
    .bind(now, now + leaseMs, ARTWORK_ID, ownerToken, fence)
    .run();
}

async function moderatePrompt(apiKey: string, prompt: string) {
  const response = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "omni-moderation-latest", input: prompt }),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new DomainError(
        "AI_CONFIGURATION_ERROR",
        "Live image editing could not authenticate. Nothing was added to history.",
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new DomainError(
        "PROVIDER_TEMPORARY",
        "Live image editing is temporarily unavailable. Nothing was added to history.",
      );
    }
    throw new DomainError("CONTENT_POLICY", "This prompt cannot be submitted as written.");
  }
  const body = (await response.json()) as { results?: Array<{ flagged?: boolean }> };
  if (body.results?.[0]?.flagged) {
    throw new DomainError(
      "CONTENT_POLICY",
      "This prompt cannot be submitted. Describe a safe visual change without personal information.",
    );
  }
}

async function generateOpenAiPatch(
  env: AppEnv,
  job: QueueJob,
  apiKey: string,
): Promise<{ bytes: Uint8Array; contentType: string; providerRequestId?: string }> {
  if (!job.sourceBlobId || !job.maskBlobId) {
    throw new DomainError("INTERNAL_ERROR", "The image-edit inputs are missing.");
  }
  const [sourceRecord, maskRecord] = await Promise.all([
    getBlobRecord(env, job.sourceBlobId),
    getBlobRecord(env, job.maskBlobId),
  ]);
  if (!sourceRecord || !maskRecord) {
    throw new DomainError("INTERNAL_ERROR", "The image-edit inputs could not be resolved.");
  }
  const [source, mask] = await Promise.all([
    env.BLOBS.get(sourceRecord.r2Key),
    env.BLOBS.get(maskRecord.r2Key),
  ]);
  if (!source || !mask) {
    throw new DomainError("INTERNAL_ERROR", "The image-edit inputs are no longer available.");
  }

  const form = new FormData();
  form.append("model", "gpt-image-2");
  form.append(
    "image[]",
    new File([await source.arrayBuffer()], "palimpsest-tile.png", { type: "image/png" }),
  );
  form.append(
    "mask",
    new File([await mask.arrayBuffer()], "palimpsest-mask.png", { type: "image/png" }),
  );
  form.append(
    "prompt",
    buildOpenAiEditPrompt(job.prompt),
  );
  form.append("size", "1024x1024");
  form.append("quality", "medium");
  form.append("output_format", "png");
  form.append("moderation", "auto");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 150_000);
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch {
    throw new DomainError(
      "PROVIDER_TEMPORARY",
      "Live image editing did not respond in time. Nothing was added to history.",
    );
  } finally {
    clearTimeout(timeout);
  }

  const providerRequestId = response.headers.get("x-request-id") ?? undefined;
  const body = (await response.json().catch(() => null)) as
    | { data?: Array<{ b64_json?: string }>; error?: { code?: string } }
    | null;
  if (!response.ok) {
    if (body?.error?.code === "moderation_blocked") {
      throw new DomainError(
        "CONTENT_POLICY",
        "This edit could not be completed because it did not meet safety requirements.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new DomainError(
        "AI_CONFIGURATION_ERROR",
        "Live image editing could not authenticate. Nothing was added to history.",
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new DomainError(
        "PROVIDER_TEMPORARY",
        "Live image editing is temporarily unavailable. Nothing was added to history.",
      );
    }
    throw new DomainError(
      "AI_CONFIGURATION_ERROR",
      "Live image editing rejected the supplied image or mask. Nothing was added to history.",
    );
  }

  const encoded = body?.data?.[0]?.b64_json;
  if (!encoded) {
    throw new DomainError("PROVIDER_TEMPORARY", "Live image editing returned no image.");
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const dimensions = readPngDimensions(bytes);
  if (dimensions.width !== 1024 || dimensions.height !== 1024) {
    throw new DomainError("PROVIDER_TEMPORARY", "Live image editing returned an invalid tile size.");
  }
  return { bytes, contentType: "image/png", providerRequestId };
}

async function commitPatch(
  env: AppEnv,
  job: QueueJob,
  patch: { bytes: Uint8Array; contentType: string; providerRequestId?: string },
  ownerToken: string,
  fence: number,
  sequence: number,
) {
  if (job.tileX == null || job.tileY == null || !job.displayMaskBlobId) {
    throw new DomainError("INTERNAL_ERROR", "The patch metadata is incomplete.");
  }
  const revisionId = crypto.randomUUID();
  const blobId = crypto.randomUUID();
  const hash = await sha256Hex(patch.bytes);
  const extension = patch.contentType === "image/png" ? "png" : "svg";
  const key = `artworks/palimpsest/patches/${revisionId}/tile-${job.tileX}-${job.tileY}-${hash}.${extension}`;
  const now = Date.now();
  await env.BLOBS.put(key, patch.bytes, {
    httpMetadata: { contentType: patch.contentType },
    customMetadata: { sha256: hash, immutable: "true" },
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO blobs
       (id, artwork_id, kind, r2_key, content_type, byte_length, sha256, width, height, created_at)
       VALUES (?, ?, 'patch', ?, ?, ?, ?, 1024, 1024, ?)`,
    ).bind(blobId, ARTWORK_ID, key, patch.contentType, patch.bytes.byteLength, hash, now),
    env.DB.prepare(
      `INSERT INTO revisions
       (id, artwork_id, sequence, parent_revision_id, job_id, origin, status, author_id,
        prompt, region_x, region_y, region_width, region_height, tile_x, tile_y, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      revisionId,
      ARTWORK_ID,
      sequence,
      job.baseRevisionId,
      job.id,
      job.executionMode,
      job.authorId,
      job.prompt,
      job.regionX,
      job.regionY,
      job.regionWidth,
      job.regionHeight,
      job.tileX,
      job.tileY,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO revision_patches
       (revision_id, tile_x, tile_y, patch_blob_id, display_mask_blob_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(revisionId, job.tileX, job.tileY, blobId, job.displayMaskBlobId),
    env.DB.prepare(
      `UPDATE artworks SET head_revision_id = ?, head_sequence = ?
       WHERE id = ? AND head_revision_id = ?`,
    ).bind(revisionId, sequence, ARTWORK_ID, job.baseRevisionId),
    env.DB.prepare(
      `UPDATE edit_jobs
       SET state = 'succeeded', result_revision_id = ?, openai_request_id = ?,
           updated_at = ?, completed_at = ?
       WHERE id = ? AND worker_token = ? AND lock_fence = ?`,
    ).bind(revisionId, patch.providerRequestId ?? null, now, now, job.id, ownerToken, fence),
    env.DB.prepare(
      `UPDATE queue_locks
       SET state = 'idle', owner_token = NULL, job_id = NULL,
           acquired_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL
       WHERE artwork_id = ? AND owner_token = ? AND fence = ?`,
    ).bind(ARTWORK_ID, ownerToken, fence),
  ]);
}

async function commitRevert(
  env: AppEnv,
  job: QueueJob,
  ownerToken: string,
  fence: number,
  sequence: number,
) {
  if (!job.targetRevisionId) {
    throw new DomainError("INTERNAL_ERROR", "The restore target is missing.");
  }
  const revisionId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO revisions
       (id, artwork_id, sequence, parent_revision_id, job_id, origin, status, author_id,
        prompt, revert_target_revision_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'revert', 'accepted', ?, ?, ?, ?)`,
    ).bind(
      revisionId,
      ARTWORK_ID,
      sequence,
      job.baseRevisionId,
      job.id,
      job.authorId,
      job.prompt,
      job.targetRevisionId,
      now,
    ),
    env.DB.prepare(
      `UPDATE artworks SET head_revision_id = ?, head_sequence = ?
       WHERE id = ? AND head_revision_id = ?`,
    ).bind(revisionId, sequence, ARTWORK_ID, job.baseRevisionId),
    env.DB.prepare(
      `UPDATE edit_jobs SET state = 'succeeded', result_revision_id = ?,
       updated_at = ?, completed_at = ?
       WHERE id = ? AND worker_token = ? AND lock_fence = ?`,
    ).bind(revisionId, now, now, job.id, ownerToken, fence),
    env.DB.prepare(
      `UPDATE queue_locks
       SET state = 'idle', owner_token = NULL, job_id = NULL,
           acquired_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL
       WHERE artwork_id = ? AND owner_token = ? AND fence = ?`,
    ).bind(ARTWORK_ID, ownerToken, fence),
  ]);
}

async function handleFailure(
  env: AppEnv,
  job: QueueJob,
  ownerToken: string,
  fence: number,
  error: unknown,
) {
  const domain = error instanceof DomainError ? error : null;
  const now = Date.now();
  if (domain?.code === "PROVIDER_TEMPORARY" && Number(job.attemptCount) < 2) {
    const attempt = Number(job.attemptCount) + 1;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE edit_jobs
         SET state = 'queued', attempt_count = ?, available_at = ?, worker_token = NULL,
             lock_fence = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND worker_token = ? AND lock_fence = ?`,
      ).bind(attempt, now + attempt * 5000, now, job.id, ownerToken, fence),
      env.DB.prepare(
        `UPDATE queue_locks
         SET state = 'idle', owner_token = NULL, job_id = NULL,
             acquired_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL
         WHERE artwork_id = ? AND owner_token = ? AND fence = ?`,
      ).bind(ARTWORK_ID, ownerToken, fence),
    ]);
    return;
  }

  const state =
    domain?.code === "STALE_BASE_REVISION"
      ? "stale"
      : domain?.code === "CONTENT_POLICY"
        ? "rejected"
        : "failed";
  const code = domain?.code ?? "INTERNAL_ERROR";
  const message =
    domain?.message ?? "The edit could not be completed. Nothing was added to history.";
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE edit_jobs
       SET state = ?, error_code = ?, public_error_message = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND worker_token = ? AND lock_fence = ?`,
    ).bind(state, code, message, now, now, job.id, ownerToken, fence),
    env.DB.prepare(
      `UPDATE queue_locks
       SET state = 'idle', owner_token = NULL, job_id = NULL,
           acquired_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL
       WHERE artwork_id = ? AND owner_token = ? AND fence = ?`,
    ).bind(ARTWORK_ID, ownerToken, fence),
  ]);
}

async function releaseLock(env: AppEnv, ownerToken: string, fence: number) {
  await env.DB.prepare(
    `UPDATE queue_locks
     SET state = 'idle', owner_token = NULL, job_id = NULL,
         acquired_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL
     WHERE artwork_id = ? AND owner_token = ? AND fence = ?`,
  )
    .bind(ARTWORK_ID, ownerToken, fence)
    .run();
}
