import {
  ARTWORK_ID,
  DomainError,
  buildOpenAiEditPrompt,
} from "./domain.mjs";
import type { AppEnv } from "./runtime";
import { readPngDimensions, sha256Hex } from "./runtime";
import {
  PREPARING_AVAILABLE_AT,
  RESERVATION_LEASE_MS,
  getBlobRecord,
  type GenerationFrame,
  type GlobalRegion,
} from "./store";

type QueueJob = {
  id: string;
  kind: "edit" | "revert";
  state: "moderating" | "generating" | "committing";
  authorId: string;
  baseRevisionId: string;
  targetRevisionId: string | null;
  prompt: string;
  regionX: number | null;
  regionY: number | null;
  regionWidth: number | null;
  regionHeight: number | null;
  frameX: number | null;
  frameY: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  sourceBlobId: string | null;
  maskBlobId: string | null;
  displayMaskBlobId: string | null;
  referenceBlobId: string | null;
  attemptCount: number;
  leaseFence: number;
  workerToken: string;
  createdAt: number;
};

type CommitLock = {
  ownerToken: string;
  fence: number;
};

const MAX_ATTEMPTS = 2;
const COMMIT_LOCK_LEASE_MS = 15_000;
const COMMIT_LOCK_ATTEMPTS = 40;
const COMMIT_LOCK_RETRY_MS = 25;
const MODERATION_TIMEOUT_MS = 30_000;
const IMAGE_EDIT_TIMEOUT_MS = 150_000;

export type QueueProcessResult = {
  claimed: number;
  completed: number;
  workerFailures: number;
};

function jobRegion(job: QueueJob): GlobalRegion {
  if (
    job.regionX == null ||
    job.regionY == null ||
    job.regionWidth == null ||
    job.regionHeight == null
  ) {
    throw new DomainError("INTERNAL_ERROR", "The queued reservation has no region.");
  }
  return {
    x: Number(job.regionX),
    y: Number(job.regionY),
    width: Number(job.regionWidth),
    height: Number(job.regionHeight),
  };
}

function jobFrame(job: QueueJob): GenerationFrame {
  if (
    job.frameX == null ||
    job.frameY == null ||
    job.frameWidth !== 1024 ||
    job.frameHeight !== 1024
  ) {
    throw new DomainError("INTERNAL_ERROR", "The queued edit has no valid generation frame.");
  }
  return {
    x: Number(job.frameX),
    y: Number(job.frameY),
    width: Number(job.frameWidth),
    height: Number(job.frameHeight),
  };
}

export async function processQueue(
  env: AppEnv,
  maxJobs = 4,
): Promise<QueueProcessResult> {
  const boundedMaxJobs = Math.max(1, Math.min(8, Math.floor(maxJobs)));
  await recoverExpiredJobs(env, Date.now());

  const claimed: QueueJob[] = [];
  for (let index = 0; index < boundedMaxJobs; index += 1) {
    const job = await claimNextJob(env);
    if (!job) break;
    claimed.push(job);
  }

  const results = await Promise.allSettled(
    claimed.map((job) => processClaimedJob(env, job)),
  );
  return {
    claimed: claimed.length,
    completed: results.filter((result) => result.status === "fulfilled").length,
    workerFailures: results.filter((result) => result.status === "rejected").length,
  };
}

export const CLAIM_NEXT_JOB_SQL = `UPDATE edit_jobs
SET state = CASE
      WHEN kind = 'revert' THEN 'committing'
      ELSE 'moderating'
    END,
    worker_token = ?,
    lease_fence = lease_fence + 1,
    lease_expires_at = ?,
    started_at = COALESCE(started_at, ?),
    updated_at = ?
WHERE id = (
  SELECT candidate.id
  FROM edit_jobs candidate
  WHERE candidate.artwork_id = ?
    AND candidate.state = 'queued'
    AND candidate.available_at <= ?
    AND candidate.lease_expires_at > ?
    AND (candidate.kind = 'revert' OR candidate.execution_mode = 'openai')
    AND NOT EXISTS (
      SELECT 1 FROM edit_jobs active
      WHERE active.artwork_id = candidate.artwork_id
        AND active.id <> candidate.id
        AND active.state IN ('queued', 'moderating', 'generating', 'committing')
        AND active.lease_expires_at > ?
        AND active.region_x < candidate.region_x + candidate.region_width
        AND active.region_x + active.region_width > candidate.region_x
        AND active.region_y < candidate.region_y + candidate.region_height
        AND active.region_y + active.region_height > candidate.region_y
    )
  ORDER BY candidate.created_at ASC, candidate.id ASC
  LIMIT 1
)
  AND state = 'queued'
  AND available_at <= ?
  AND lease_expires_at > ?
RETURNING
  id,
  kind,
  state,
  author_id AS authorId,
  base_revision_id AS baseRevisionId,
  target_revision_id AS targetRevisionId,
  prompt,
  region_x AS regionX,
  region_y AS regionY,
  region_width AS regionWidth,
  region_height AS regionHeight,
  frame_x AS frameX,
  frame_y AS frameY,
  frame_width AS frameWidth,
  frame_height AS frameHeight,
  source_blob_id AS sourceBlobId,
  mask_blob_id AS maskBlobId,
  display_mask_blob_id AS displayMaskBlobId,
  reference_blob_id AS referenceBlobId,
  attempt_count AS attemptCount,
  lease_fence AS leaseFence,
  worker_token AS workerToken,
  created_at AS createdAt`;

async function claimNextJob(env: AppEnv): Promise<QueueJob | null> {
  const workerToken = crypto.randomUUID();
  const now = Date.now();
  return env.DB.prepare(CLAIM_NEXT_JOB_SQL)
    .bind(
      workerToken,
      now + RESERVATION_LEASE_MS,
      now,
      now,
      ARTWORK_ID,
      now,
      now,
      now,
      now,
      now,
    )
    .first<QueueJob>();
}

export const EXPIRE_PREPARING_RESERVATION_SQL = `UPDATE edit_jobs
SET state = 'failed',
    error_code = 'QUEUE_PREPARATION_EXPIRED',
    public_error_message = 'The edit inputs were not prepared before the reservation expired. Nothing was added to history.',
    worker_token = NULL,
    lease_expires_at = NULL,
    updated_at = ?,
    completed_at = ?
WHERE artwork_id = ?
  AND state = 'queued'
  AND available_at = ?
  AND worker_token IS NULL
  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`;

export const EXPIRE_READY_QUEUE_RESERVATION_SQL = `UPDATE edit_jobs
SET state = 'failed',
    error_code = 'QUEUE_LEASE_EXPIRED',
    public_error_message = 'The queued edit was not claimed before its reservation expired. Nothing was added to history.',
    worker_token = NULL,
    lease_expires_at = NULL,
    updated_at = ?,
    completed_at = ?
WHERE artwork_id = ?
  AND state = 'queued'
  AND available_at <> ?
  AND worker_token IS NULL
  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`;

export const RETIRE_NON_LIVE_EDIT_JOBS_SQL = `UPDATE edit_jobs
SET state = 'failed',
    error_code = 'NON_LIVE_MODE_REMOVED',
    public_error_message = 'This queued edit used a retired non-live renderer. Submit it again for live AI generation.',
    worker_token = NULL,
    lease_expires_at = NULL,
    updated_at = ?,
    completed_at = ?
WHERE artwork_id = ?
  AND kind = 'edit'
  AND execution_mode <> 'openai'
  AND state IN ('queued', 'moderating', 'generating', 'committing')`;

export const SUPERSEDE_EXPIRED_ACTIVE_RESERVATION_SQL = `UPDATE edit_jobs
SET state = 'failed',
    error_code = 'QUEUE_RESERVATION_SUPERSEDED',
    public_error_message = 'A newer contribution reserved this area after the worker lease expired. Nothing was added to history.',
    worker_token = NULL,
    lease_expires_at = NULL,
    updated_at = ?,
    completed_at = ?
WHERE artwork_id = ?
  AND state IN ('moderating', 'generating', 'committing')
  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
  AND EXISTS (
    SELECT 1 FROM edit_jobs active
    WHERE active.artwork_id = edit_jobs.artwork_id
      AND active.id <> edit_jobs.id
      AND active.state IN ('queued', 'moderating', 'generating', 'committing')
      AND active.lease_expires_at > ?
      AND active.region_x < edit_jobs.region_x + edit_jobs.region_width
      AND active.region_x + active.region_width > edit_jobs.region_x
      AND active.region_y < edit_jobs.region_y + edit_jobs.region_height
      AND active.region_y + active.region_height > edit_jobs.region_y
  )`;

export const REQUEUE_EXPIRED_ACTIVE_RESERVATION_SQL = `UPDATE edit_jobs
SET state = 'queued',
    attempt_count = attempt_count + 1,
    available_at = ?,
    worker_token = NULL,
    lease_expires_at = ?,
    updated_at = ?
WHERE artwork_id = ?
  AND state IN ('moderating', 'generating', 'committing')
  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
  AND attempt_count < ?
  AND NOT EXISTS (
    SELECT 1 FROM edit_jobs active
    WHERE active.artwork_id = edit_jobs.artwork_id
      AND active.id <> edit_jobs.id
      AND active.state IN ('queued', 'moderating', 'generating', 'committing')
      AND active.lease_expires_at > ?
      AND active.region_x < edit_jobs.region_x + edit_jobs.region_width
      AND active.region_x + active.region_width > edit_jobs.region_x
      AND active.region_y < edit_jobs.region_y + edit_jobs.region_height
      AND active.region_y + active.region_height > edit_jobs.region_y
  )`;

async function recoverExpiredJobs(env: AppEnv, now: number) {
  await env.DB.batch([
    env.DB.prepare(RETIRE_NON_LIVE_EDIT_JOBS_SQL).bind(
      now,
      now,
      ARTWORK_ID,
    ),
    env.DB.prepare(EXPIRE_PREPARING_RESERVATION_SQL).bind(
      now,
      now,
      ARTWORK_ID,
      PREPARING_AVAILABLE_AT,
      now,
    ),
    env.DB.prepare(EXPIRE_READY_QUEUE_RESERVATION_SQL).bind(
      now,
      now,
      ARTWORK_ID,
      PREPARING_AVAILABLE_AT,
      now,
    ),
    env.DB.prepare(SUPERSEDE_EXPIRED_ACTIVE_RESERVATION_SQL).bind(
      now,
      now,
      ARTWORK_ID,
      now,
      now,
    ),
    env.DB.prepare(
      `UPDATE edit_jobs
       SET state = 'failed',
           error_code = 'QUEUE_LEASE_EXPIRED',
           public_error_message = 'The worker lease expired repeatedly. Nothing was added to history.',
           worker_token = NULL,
           lease_expires_at = NULL,
           updated_at = ?,
           completed_at = ?
       WHERE artwork_id = ?
         AND state IN ('moderating', 'generating', 'committing')
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         AND attempt_count >= ?`,
    ).bind(now, now, ARTWORK_ID, now, MAX_ATTEMPTS),
    env.DB.prepare(REQUEUE_EXPIRED_ACTIVE_RESERVATION_SQL).bind(
      now,
      now + RESERVATION_LEASE_MS,
      now,
      ARTWORK_ID,
      now,
      MAX_ATTEMPTS,
      now,
    ),
  ]);
}

async function processClaimedJob(env: AppEnv, job: QueueJob) {
  try {
    if (job.kind === "revert") {
      await commitRevert(env, job);
      return;
    }

    jobRegion(job);
    jobFrame(job);
    if (!job.displayMaskBlobId) {
      throw new DomainError("INTERNAL_ERROR", "The generated layer mask is missing.");
    }

    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new DomainError(
        "AI_CONFIGURATION_ERROR",
        "Live AI editing is not configured. Nothing was added to history.",
      );
    }
    await moderatePrompt(apiKey, job.prompt);
    await updateStage(env, job, "moderating", "generating");
    const patch = await generateOpenAiPatch(env, job, apiKey);

    await updateStage(env, job, "generating", "committing");
    await commitPatch(env, job, patch);
  } catch (error) {
    await handleFailure(env, job, error);
  }
}

async function updateStage(
  env: AppEnv,
  job: QueueJob,
  expectedState: QueueJob["state"],
  nextState: QueueJob["state"],
) {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE edit_jobs
     SET state = ?, updated_at = ?, lease_expires_at = ?
     WHERE id = ?
       AND artwork_id = ?
       AND state = ?
       AND worker_token = ?
       AND lease_fence = ?
       AND lease_expires_at > ?`,
  )
    .bind(
      nextState,
      now,
      now + RESERVATION_LEASE_MS,
      job.id,
      ARTWORK_ID,
      expectedState,
      job.workerToken,
      job.leaseFence,
      now,
    )
    .run();
  if (Number(result.meta.changes ?? 0) === 0) {
    throw new DomainError(
      "QUEUE_LEASE_EXPIRED",
      "The worker lease expired before the edit could advance safely.",
    );
  }
  job.state = nextState;
}

async function moderatePrompt(apiKey: string, prompt: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODERATION_TIMEOUT_MS);
  let response: Response;
  let body: { results?: Array<{ flagged?: boolean }> } | null;
  try {
    response = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input: prompt }),
      signal: controller.signal,
    });
    body = (await response.json().catch(() => null)) as {
      results?: Array<{ flagged?: boolean }>;
    } | null;
  } catch {
    throw new DomainError(
      "PROVIDER_TEMPORARY",
      "Live image editing did not respond in time. Nothing was added to history.",
    );
  } finally {
    clearTimeout(timeout);
  }
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
  const result = body?.results?.[0];
  if (!result) {
    throw new DomainError(
      "PROVIDER_TEMPORARY",
      "Live image editing returned an invalid moderation response. Nothing was added to history.",
    );
  }
  if (result.flagged) {
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
  const [sourceRecord, maskRecord, referenceRecord] = await Promise.all([
    getBlobRecord(env, job.sourceBlobId),
    getBlobRecord(env, job.maskBlobId),
    job.referenceBlobId ? getBlobRecord(env, job.referenceBlobId) : Promise.resolve(null),
  ]);
  if (!sourceRecord || !maskRecord) {
    throw new DomainError("INTERNAL_ERROR", "The image-edit inputs could not be resolved.");
  }
  if (job.referenceBlobId && !referenceRecord) {
    throw new DomainError("INTERNAL_ERROR", "The reference image could not be resolved.");
  }
  const [source, mask, reference] = await Promise.all([
    env.BLOBS.get(sourceRecord.r2Key),
    env.BLOBS.get(maskRecord.r2Key),
    referenceRecord ? env.BLOBS.get(referenceRecord.r2Key) : Promise.resolve(null),
  ]);
  if (!source || !mask) {
    throw new DomainError("INTERNAL_ERROR", "The image-edit inputs are no longer available.");
  }
  if (referenceRecord && !reference) {
    throw new DomainError("INTERNAL_ERROR", "The reference image is no longer available.");
  }

  const form = new FormData();
  form.append("model", "gpt-image-2");
  form.append(
    "image[]",
    new File([await source.arrayBuffer()], "palimpsest-context.png", {
      type: "image/png",
    }),
  );
  form.append(
    "mask",
    new File([await mask.arrayBuffer()], "palimpsest-mask.png", {
      type: "image/png",
    }),
  );
  if (reference) {
    form.append(
      "image[]",
      new File([await reference.arrayBuffer()], "palimpsest-reference.png", {
        type: "image/png",
      }),
    );
  }
  form.append("prompt", buildOpenAiEditPrompt(job.prompt, Boolean(reference)));
  form.append("size", "1024x1024");
  form.append("quality", "medium");
  form.append("output_format", "png");
  form.append("moderation", "auto");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_EDIT_TIMEOUT_MS);
  let response: Response;
  let body:
    | { data?: Array<{ b64_json?: string }>; error?: { code?: string } }
    | null;
  try {
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    body = (await response.json().catch(() => null)) as
      | { data?: Array<{ b64_json?: string }>; error?: { code?: string } }
      | null;
  } catch {
    throw new DomainError(
      "PROVIDER_TEMPORARY",
      "Live image editing did not respond in time. Nothing was added to history.",
    );
  } finally {
    clearTimeout(timeout);
  }

  const providerRequestId = response.headers.get("x-request-id") ?? undefined;
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
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const dimensions = readPngDimensions(bytes);
  if (dimensions.width !== 1024 || dimensions.height !== 1024) {
    throw new DomainError(
      "PROVIDER_TEMPORARY",
      "Live image editing returned an invalid context-frame size.",
    );
  }
  return { bytes, contentType: "image/png", providerRequestId };
}

async function acquireCommitLock(env: AppEnv, jobId: string): Promise<CommitLock> {
  const ownerToken = crypto.randomUUID();
  for (let attempt = 0; attempt < COMMIT_LOCK_ATTEMPTS; attempt += 1) {
    const now = Date.now();
    const lock = await env.DB.prepare(
      `UPDATE artwork_commit_locks
       SET owner_token = ?,
           fence = fence + 1,
           job_id = ?,
           acquired_at = ?,
           lease_expires_at = ?
       WHERE artwork_id = ?
         AND (owner_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
       RETURNING fence`,
    )
      .bind(
        ownerToken,
        jobId,
        now,
        now + COMMIT_LOCK_LEASE_MS,
        ARTWORK_ID,
        now,
      )
      .first<{ fence: number }>();
    if (lock) return { ownerToken, fence: Number(lock.fence) };
    await new Promise((resolve) => setTimeout(resolve, COMMIT_LOCK_RETRY_MS));
  }
  throw new DomainError(
    "PROVIDER_TEMPORARY",
    "The final history commit is busy. This edit will be retried safely.",
  );
}

async function releaseCommitLock(env: AppEnv, lock: CommitLock) {
  await env.DB.prepare(
    `UPDATE artwork_commit_locks
     SET owner_token = NULL, job_id = NULL, acquired_at = NULL, lease_expires_at = NULL
     WHERE artwork_id = ? AND owner_token = ? AND fence = ?`,
  )
    .bind(ARTWORK_ID, lock.ownerToken, lock.fence)
    .run();
}

async function assertCommitStillValid(
  env: AppEnv,
  job: QueueJob,
  lock: CommitLock,
) {
  const now = Date.now();
  const checks = await env.DB.batch([
    env.DB.prepare(
      `SELECT j.id
       FROM edit_jobs j
       JOIN artwork_commit_locks commit_lock
         ON commit_lock.artwork_id = j.artwork_id
       WHERE j.id = ?
         AND j.artwork_id = ?
         AND j.state = 'committing'
         AND j.worker_token = ?
         AND j.lease_fence = ?
         AND j.lease_expires_at > ?
         AND commit_lock.owner_token = ?
         AND commit_lock.fence = ?
         AND commit_lock.job_id = j.id
         AND commit_lock.lease_expires_at > ?`,
    ).bind(
      job.id,
      ARTWORK_ID,
      job.workerToken,
      job.leaseFence,
      now,
      lock.ownerToken,
      lock.fence,
      now,
    ),
    env.DB.prepare(
      `SELECT accepted.id, accepted.sequence
       FROM edit_jobs job
       JOIN revisions base
         ON base.artwork_id = job.artwork_id AND base.id = job.base_revision_id
       JOIN revisions accepted
         ON accepted.artwork_id = base.artwork_id
        AND accepted.sequence > base.sequence
       WHERE job.id = ?
         AND accepted.region_x IS NOT NULL
         AND accepted.region_x < job.region_x + job.region_width
         AND accepted.region_x + accepted.region_width > job.region_x
         AND accepted.region_y < job.region_y + job.region_height
         AND accepted.region_y + accepted.region_height > job.region_y
       ORDER BY accepted.sequence ASC
       LIMIT 1`,
    ).bind(job.id),
    env.DB.prepare(
      `SELECT active.id
       FROM edit_jobs job
       JOIN edit_jobs active
         ON active.artwork_id = job.artwork_id AND active.id <> job.id
       WHERE job.id = ?
         AND active.state IN ('queued', 'moderating', 'generating', 'committing')
         AND active.lease_expires_at > ?
         AND active.region_x < job.region_x + job.region_width
         AND active.region_x + active.region_width > job.region_x
         AND active.region_y < job.region_y + job.region_height
         AND active.region_y + active.region_height > job.region_y
       ORDER BY active.created_at ASC
       LIMIT 1`,
    ).bind(job.id, now),
  ]);

  if (!checks[0]?.results?.[0]) {
    throw new DomainError(
      "QUEUE_LEASE_EXPIRED",
      "The worker lease was superseded before the final commit.",
    );
  }
  if (checks[1]?.results?.[0]) {
    throw new DomainError(
      "STALE_BASE_REVISION",
      "An accepted revision changed this region after the edit began. Nothing was added to history.",
    );
  }
  if (checks[2]?.results?.[0]) {
    throw new DomainError(
      "STALE_BASE_REVISION",
      "Another active reservation superseded this region before commit. Nothing was added to history.",
    );
  }
}

export const COMMIT_PATCH_REVISION_SQL = `WITH candidate(
  revision_id, job_id, worker_token, lease_fence,
  commit_token, commit_fence, now_ms
) AS (VALUES (?, ?, ?, ?, ?, ?, ?))
INSERT INTO revisions (
  id, artwork_id, sequence, parent_revision_id, job_id, origin, status,
  author_id, prompt, region_x, region_y, region_width, region_height, created_at
)
SELECT
  c.revision_id,
  job.artwork_id,
  artwork.head_sequence + 1,
  artwork.head_revision_id,
  job.id,
  job.execution_mode,
  'accepted',
  job.author_id,
  job.prompt,
  job.region_x,
  job.region_y,
  job.region_width,
  job.region_height,
  c.now_ms
FROM candidate c
JOIN edit_jobs job ON job.id = c.job_id
JOIN artworks artwork ON artwork.id = job.artwork_id
JOIN revisions base
  ON base.artwork_id = job.artwork_id AND base.id = job.base_revision_id
JOIN artwork_commit_locks commit_lock
  ON commit_lock.artwork_id = job.artwork_id
WHERE job.state = 'committing'
  AND job.kind = 'edit'
  AND job.execution_mode = 'openai'
  AND job.worker_token = c.worker_token
  AND job.lease_fence = c.lease_fence
  AND job.lease_expires_at > c.now_ms
  AND commit_lock.owner_token = c.commit_token
  AND commit_lock.fence = c.commit_fence
  AND commit_lock.job_id = job.id
  AND commit_lock.lease_expires_at > c.now_ms
  AND NOT EXISTS (
    SELECT 1 FROM revisions accepted
    WHERE accepted.artwork_id = job.artwork_id
      AND accepted.sequence > base.sequence
      AND accepted.region_x IS NOT NULL
      AND accepted.region_x < job.region_x + job.region_width
      AND accepted.region_x + accepted.region_width > job.region_x
      AND accepted.region_y < job.region_y + job.region_height
      AND accepted.region_y + accepted.region_height > job.region_y
  )
  AND NOT EXISTS (
    SELECT 1 FROM edit_jobs active
    WHERE active.artwork_id = job.artwork_id
      AND active.id <> job.id
      AND active.state IN ('queued', 'moderating', 'generating', 'committing')
      AND active.lease_expires_at > c.now_ms
      AND active.region_x < job.region_x + job.region_width
      AND active.region_x + active.region_width > job.region_x
      AND active.region_y < job.region_y + job.region_height
      AND active.region_y + active.region_height > job.region_y
  )`;

async function commitPatch(
  env: AppEnv,
  job: QueueJob,
  patch: { bytes: Uint8Array; contentType: string; providerRequestId?: string },
) {
  const frame = jobFrame(job);
  const displayMaskBlobId = job.displayMaskBlobId;
  if (!displayMaskBlobId) {
    throw new DomainError("INTERNAL_ERROR", "The generated layer mask is missing.");
  }

  const revisionId = crypto.randomUUID();
  const blobId = crypto.randomUUID();
  const hash = await sha256Hex(patch.bytes);
  const key = `artworks/palimpsest/patches/${revisionId}/frame-${frame.x}-${frame.y}-${hash}.png`;
  await env.BLOBS.put(key, patch.bytes, {
    httpMetadata: { contentType: patch.contentType },
    customMetadata: { sha256: hash, immutable: "true" },
  });

  const lock = await acquireCommitLock(env, job.id);
  try {
    await assertCommitStillValid(env, job, lock);
    const now = Date.now();
    const committed = await env.DB.batch([
      env.DB.prepare(COMMIT_PATCH_REVISION_SQL).bind(
        revisionId,
        job.id,
        job.workerToken,
        job.leaseFence,
        lock.ownerToken,
        lock.fence,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO blobs (
           id, artwork_id, kind, r2_key, content_type, byte_length,
           sha256, width, height, created_at
         )
         SELECT ?, ?, 'patch', ?, ?, ?, ?, 1024, 1024, ?
         WHERE EXISTS (SELECT 1 FROM revisions WHERE id = ?)`,
      ).bind(
        blobId,
        ARTWORK_ID,
        key,
        patch.contentType,
        patch.bytes.byteLength,
        hash,
        now,
        revisionId,
      ),
      env.DB.prepare(
        `INSERT INTO revision_patches (
           revision_id, patch_blob_id, display_mask_blob_id,
           frame_x, frame_y, frame_width, frame_height
         )
         SELECT ?, ?, ?, frame_x, frame_y, frame_width, frame_height
         FROM edit_jobs
         WHERE id = ? AND EXISTS (SELECT 1 FROM revisions WHERE id = ?)`,
      ).bind(
        revisionId,
        blobId,
        displayMaskBlobId,
        job.id,
        revisionId,
      ),
      env.DB.prepare(
        `UPDATE artworks
         SET head_revision_id = ?,
             head_sequence = (SELECT sequence FROM revisions WHERE id = ?)
         WHERE id = ?
           AND EXISTS (SELECT 1 FROM revisions WHERE id = ?)
           AND head_revision_id = (
             SELECT parent_revision_id FROM revisions WHERE id = ?
           )`,
      ).bind(revisionId, revisionId, ARTWORK_ID, revisionId, revisionId),
      env.DB.prepare(
        `UPDATE edit_jobs
         SET state = 'succeeded',
             result_revision_id = ?,
             openai_request_id = ?,
             worker_token = NULL,
             lease_expires_at = NULL,
             updated_at = ?,
             completed_at = ?
         WHERE id = ?
           AND worker_token = ?
           AND lease_fence = ?
           AND EXISTS (SELECT 1 FROM revisions WHERE id = ?)`,
      ).bind(
        revisionId,
        patch.providerRequestId ?? null,
        now,
        now,
        job.id,
        job.workerToken,
        job.leaseFence,
        revisionId,
      ),
      env.DB.prepare(
        `UPDATE artwork_commit_locks
         SET owner_token = NULL, job_id = NULL, acquired_at = NULL,
             lease_expires_at = NULL
         WHERE artwork_id = ? AND owner_token = ? AND fence = ?`,
      ).bind(ARTWORK_ID, lock.ownerToken, lock.fence),
    ]);

    if (Number(committed[0]?.meta.changes ?? 0) === 0) {
      throw new DomainError(
        "STALE_BASE_REVISION",
        "This generated patch could not be rebased safely. Nothing was added to history.",
      );
    }
  } finally {
    await releaseCommitLock(env, lock);
  }
}

export const COMMIT_REVERT_REVISION_SQL = `WITH candidate(
  revision_id, job_id, worker_token, lease_fence,
  commit_token, commit_fence, now_ms
) AS (VALUES (?, ?, ?, ?, ?, ?, ?))
INSERT INTO revisions (
  id, artwork_id, sequence, parent_revision_id, job_id, origin, status,
  author_id, prompt, region_x, region_y, region_width, region_height,
  revert_target_revision_id, created_at
)
SELECT
  c.revision_id,
  job.artwork_id,
  artwork.head_sequence + 1,
  artwork.head_revision_id,
  job.id,
  'revert',
  'accepted',
  job.author_id,
  job.prompt,
  job.region_x,
  job.region_y,
  job.region_width,
  job.region_height,
  job.target_revision_id,
  c.now_ms
FROM candidate c
JOIN edit_jobs job ON job.id = c.job_id
JOIN artworks artwork ON artwork.id = job.artwork_id
JOIN revisions base
  ON base.artwork_id = job.artwork_id AND base.id = job.base_revision_id
JOIN artwork_commit_locks commit_lock
  ON commit_lock.artwork_id = job.artwork_id
WHERE job.kind = 'revert'
  AND job.state = 'committing'
  AND job.worker_token = c.worker_token
  AND job.lease_fence = c.lease_fence
  AND job.lease_expires_at > c.now_ms
  AND commit_lock.owner_token = c.commit_token
  AND commit_lock.fence = c.commit_fence
  AND commit_lock.job_id = job.id
  AND commit_lock.lease_expires_at > c.now_ms
  AND NOT EXISTS (
    SELECT 1 FROM revisions accepted
    WHERE accepted.artwork_id = job.artwork_id
      AND accepted.sequence > base.sequence
      AND accepted.region_x IS NOT NULL
      AND accepted.region_x < job.region_x + job.region_width
      AND accepted.region_x + accepted.region_width > job.region_x
      AND accepted.region_y < job.region_y + job.region_height
      AND accepted.region_y + accepted.region_height > job.region_y
  )
  AND NOT EXISTS (
    SELECT 1 FROM edit_jobs active
    WHERE active.artwork_id = job.artwork_id
      AND active.id <> job.id
      AND active.state IN ('queued', 'moderating', 'generating', 'committing')
      AND active.lease_expires_at > c.now_ms
      AND active.region_x < job.region_x + job.region_width
      AND active.region_x + active.region_width > job.region_x
      AND active.region_y < job.region_y + job.region_height
      AND active.region_y + active.region_height > job.region_y
  )`;

async function commitRevert(env: AppEnv, job: QueueJob) {
  if (!job.targetRevisionId) {
    throw new DomainError("INTERNAL_ERROR", "The restore target is missing.");
  }
  jobRegion(job);
  const revisionId = crypto.randomUUID();
  const lock = await acquireCommitLock(env, job.id);
  try {
    await assertCommitStillValid(env, job, lock);
    const now = Date.now();
    const committed = await env.DB.batch([
      env.DB.prepare(COMMIT_REVERT_REVISION_SQL).bind(
        revisionId,
        job.id,
        job.workerToken,
        job.leaseFence,
        lock.ownerToken,
        lock.fence,
        now,
      ),
      env.DB.prepare(
        `UPDATE artworks
         SET head_revision_id = ?,
             head_sequence = (SELECT sequence FROM revisions WHERE id = ?)
         WHERE id = ?
           AND EXISTS (SELECT 1 FROM revisions WHERE id = ?)
           AND head_revision_id = (
             SELECT parent_revision_id FROM revisions WHERE id = ?
           )`,
      ).bind(revisionId, revisionId, ARTWORK_ID, revisionId, revisionId),
      env.DB.prepare(
        `UPDATE edit_jobs
         SET state = 'succeeded',
             result_revision_id = ?,
             worker_token = NULL,
             lease_expires_at = NULL,
             updated_at = ?,
             completed_at = ?
         WHERE id = ?
           AND worker_token = ?
           AND lease_fence = ?
           AND EXISTS (SELECT 1 FROM revisions WHERE id = ?)`,
      ).bind(
        revisionId,
        now,
        now,
        job.id,
        job.workerToken,
        job.leaseFence,
        revisionId,
      ),
      env.DB.prepare(
        `UPDATE artwork_commit_locks
         SET owner_token = NULL, job_id = NULL, acquired_at = NULL,
             lease_expires_at = NULL
         WHERE artwork_id = ? AND owner_token = ? AND fence = ?`,
      ).bind(ARTWORK_ID, lock.ownerToken, lock.fence),
    ]);
    if (Number(committed[0]?.meta.changes ?? 0) === 0) {
      throw new DomainError(
        "STALE_BASE_REVISION",
        "The full-canvas restore could not commit against the current artwork.",
      );
    }
  } finally {
    await releaseCommitLock(env, lock);
  }
}

async function handleFailure(env: AppEnv, job: QueueJob, error: unknown) {
  const domain = error instanceof DomainError ? error : null;
  const now = Date.now();
  if (domain?.code === "PROVIDER_TEMPORARY" && job.attemptCount < MAX_ATTEMPTS) {
    const attempt = Number(job.attemptCount) + 1;
    await env.DB.prepare(
      `UPDATE edit_jobs
       SET state = 'queued',
           attempt_count = ?,
           available_at = ?,
           worker_token = NULL,
           lease_expires_at = ?,
           updated_at = ?
       WHERE id = ?
         AND worker_token = ?
         AND lease_fence = ?
         AND lease_expires_at > ?`,
    )
      .bind(
        attempt,
        now + attempt * 5000,
        now + RESERVATION_LEASE_MS,
        now,
        job.id,
        job.workerToken,
        job.leaseFence,
        now,
      )
      .run();
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
  await env.DB.prepare(
    `UPDATE edit_jobs
     SET state = ?,
         error_code = ?,
         public_error_message = ?,
         worker_token = NULL,
         lease_expires_at = NULL,
         updated_at = ?,
         completed_at = ?
     WHERE id = ?
       AND worker_token = ?
       AND lease_fence = ?
       AND lease_expires_at > ?`,
  )
    .bind(
      state,
      code,
      message,
      now,
      now,
      job.id,
      job.workerToken,
      job.leaseFence,
      now,
    )
    .run();
}
