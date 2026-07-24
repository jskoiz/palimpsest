import {
  ARTWORK_ID,
  DomainError,
  buildOpenAiEditPrompt,
} from "./domain.mjs";
import {
  buildEditOutputReviewRequest,
  buildReferenceEditReviewRequest,
  describeEditReviewResponse,
  extractEditOutputReview,
  extractReferenceEditReview,
} from "./ai-review.mjs";
import { isRetryableD1Reset, retryIdempotentD1 } from "./d1.mjs";
import type { AppEnv } from "./runtime";
import { readPngDimensions, sha256Hex } from "./runtime";
import {
  PREPARING_AVAILABLE_AT,
  getBlobRecord,
  type GenerationFrame,
  type GlobalRegion,
} from "./store";
import {
  GENERATION_FRAME_MIN_EDGE,
  GENERATION_FRAME_SIZE,
  regionInGenerationFrame,
} from "./geometry.mjs";
import {
  WORKER_HEARTBEAT_MS,
  WORKER_LEASE_MS,
} from "./worker-policy.mjs";

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
  executionMode: "openai" | "placement" | "none";
  leaseFence: number;
  workerToken: string;
  createdAt: number;
};

type EditOutputReview = {
  contained: boolean;
  blended: boolean;
  reason: string;
};

type ReferenceEditReview = EditOutputReview & {
  faithful: boolean;
  placementMatched: boolean;
  sourcePreserved: boolean;
};

type EditReviewResult =
  | {
      status: "reviewed";
      review: EditOutputReview | ReferenceEditReview;
    }
  | {
      status: "unavailable";
      detail: string;
    };

type CommitLock = {
  ownerToken: string;
  fence: number;
};

const COMMIT_LOCK_LEASE_MS = 15_000;
const COMMIT_LOCK_ATTEMPTS = 40;
const COMMIT_LOCK_RETRY_MS = 25;
const EDIT_REVIEW_MAX_ATTEMPTS = 3;
const EDIT_REVIEW_RETRY_DELAY_MS = 400;

function cleanReviewReason(reason: string) {
  return reason.replace(/\s+/g, " ").trim().slice(0, 320);
}

function reviewFailureMessage(message: string, reason: string) {
  const detail = cleanReviewReason(reason);
  return detail ? `${message} Last review: ${detail}` : message;
}

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
    job.frameWidth == null ||
    job.frameHeight == null ||
    !Number.isSafeInteger(job.frameWidth) ||
    !Number.isSafeInteger(job.frameHeight) ||
    job.frameWidth !== job.frameHeight ||
    job.frameWidth < GENERATION_FRAME_MIN_EDGE ||
    job.frameWidth > GENERATION_FRAME_SIZE
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
  maxJobs = 1,
): Promise<QueueProcessResult> {
  const boundedMaxJobs = Math.max(1, Math.min(8, Math.floor(maxJobs)));
  const now = Date.now();
  let status: { hasReady: number; needsRecovery: number } | null;
  try {
    status = await retryIdempotentD1(() =>
      env.DB.prepare(QUEUE_WORK_STATUS_SQL)
        .bind(
          ARTWORK_ID,
          PREPARING_AVAILABLE_AT,
          now,
          now,
          ARTWORK_ID,
          now,
        )
        .first<{ hasReady: number; needsRecovery: number }>(),
    );
  } catch (error) {
    if (isRetryableD1Reset(error)) {
      throw new DomainError(
        "SERVICE_UNAVAILABLE",
        "The contribution queue is briefly overloaded. Try again in a moment.",
      );
    }
    throw error;
  }
  if (!status?.hasReady && !status?.needsRecovery) {
    return { claimed: 0, completed: 0, workerFailures: 0 };
  }
  if (status.needsRecovery) {
    try {
      await retryIdempotentD1(() => recoverExpiredJobs(env, Date.now()));
    } catch (error) {
      if (isRetryableD1Reset(error)) {
        throw new DomainError(
          "SERVICE_UNAVAILABLE",
          "The contribution queue is briefly overloaded. Try again in a moment.",
        );
      }
      throw error;
    }
  }

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

export const QUEUE_WORK_STATUS_SQL = `SELECT
  EXISTS (
    SELECT 1 FROM edit_jobs
    WHERE artwork_id = ?
      AND state = 'queued'
      AND available_at <> ?
      AND available_at <= ?
      AND lease_expires_at > ?
    LIMIT 1
  ) AS hasReady,
  EXISTS (
    SELECT 1 FROM edit_jobs
    WHERE artwork_id = ?
      AND (
        (state IN ('queued', 'moderating', 'generating', 'committing')
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        OR (
          kind = 'edit'
          AND (
            execution_mode <> 'openai'
          )
          AND state IN ('queued', 'moderating', 'generating', 'committing')
        )
      )
    LIMIT 1
  ) AS needsRecovery`;

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
    AND (
      candidate.kind = 'revert'
      OR (
        candidate.kind = 'edit'
        AND candidate.execution_mode = 'openai'
      )
    )
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
  execution_mode AS executionMode,
  lease_fence AS leaseFence,
  worker_token AS workerToken,
  created_at AS createdAt`;

async function claimNextJob(env: AppEnv): Promise<QueueJob | null> {
  const workerToken = crypto.randomUUID();
  const now = Date.now();
  try {
    return await env.DB.prepare(CLAIM_NEXT_JOB_SQL)
      .bind(
        workerToken,
        now + WORKER_LEASE_MS,
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
  } catch (error) {
    if (!isRetryableD1Reset(error)) throw error;
    let reconciled: QueueJob | null;
    try {
      reconciled = await retryIdempotentD1(() =>
        env.DB.prepare(CLAIMED_JOB_BY_TOKEN_SQL)
          .bind(ARTWORK_ID, workerToken)
          .first<QueueJob>(),
      );
    } catch (reconciliationError) {
      if (!isRetryableD1Reset(reconciliationError)) throw reconciliationError;
      throw new DomainError(
        "SERVICE_UNAVAILABLE",
        "The queue could not safely confirm an ambiguous claim. Recovery will preserve it.",
      );
    }
    if (reconciled) return reconciled;
  }
  throw new DomainError(
    "SERVICE_UNAVAILABLE",
    "The queue could not confirm whether a reservation was claimed. Recovery will preserve it.",
  );
}

export const CLAIMED_JOB_BY_TOKEN_SQL = `SELECT
  id, kind, state, author_id AS authorId,
  base_revision_id AS baseRevisionId, target_revision_id AS targetRevisionId,
  prompt, region_x AS regionX, region_y AS regionY,
  region_width AS regionWidth, region_height AS regionHeight,
  frame_x AS frameX, frame_y AS frameY,
  frame_width AS frameWidth, frame_height AS frameHeight,
  source_blob_id AS sourceBlobId, mask_blob_id AS maskBlobId,
  display_mask_blob_id AS displayMaskBlobId, reference_blob_id AS referenceBlobId,
  execution_mode AS executionMode,
  lease_fence AS leaseFence,
  worker_token AS workerToken, created_at AS createdAt
FROM edit_jobs
WHERE artwork_id = ? AND worker_token = ?
  AND state IN ('moderating', 'generating', 'committing')
LIMIT 1`;

export const RENEW_WORKER_LEASE_SQL = `UPDATE edit_jobs
SET updated_at = ?,
    lease_expires_at = ?
WHERE id = ?
  AND artwork_id = ?
  AND state IN ('moderating', 'generating', 'committing')
  AND worker_token = ?
  AND lease_fence = ?
  AND lease_expires_at > ?`;

export const FAIL_CLAIMED_JOB_SQL = `UPDATE edit_jobs
SET state = ?,
    error_code = ?,
    public_error_message = ?,
    worker_token = NULL,
    lease_expires_at = NULL,
    updated_at = ?,
    completed_at = ?
WHERE id = ?
  AND worker_token = ?
  AND lease_fence = ?`;

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

export const RELEASE_FAILED_PREPARATION_RATE_CLAIMS_SQL = `DELETE FROM rate_limit_claims
WHERE job_id IN (
  SELECT id FROM edit_jobs
  WHERE artwork_id = ?
    AND state = 'failed'
    AND error_code = 'QUEUE_PREPARATION_EXPIRED'
)`;

export const RETIRE_NON_LIVE_EDIT_JOBS_SQL = `UPDATE edit_jobs
SET state = 'failed',
    error_code = 'NON_LIVE_MODE_REMOVED',
    public_error_message = 'This queued edit used a retired contribution format. Submit it again with the current editor.',
    worker_token = NULL,
    lease_expires_at = NULL,
    updated_at = ?,
    completed_at = ?
WHERE artwork_id = ?
  AND kind = 'edit'
  AND (
    execution_mode <> 'openai'
  )
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

export const EXPIRE_ACTIVE_WORKER_SQL = `UPDATE edit_jobs
SET state = 'failed',
    error_code = 'QUEUE_LEASE_EXPIRED',
    public_error_message = 'The generation worker stopped before finishing. Nothing was added to history.',
    worker_token = NULL,
    lease_expires_at = NULL,
    updated_at = ?,
    completed_at = ?
WHERE artwork_id = ?
  AND state IN ('moderating', 'generating', 'committing')
  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`;

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
    env.DB.prepare(RELEASE_FAILED_PREPARATION_RATE_CLAIMS_SQL).bind(ARTWORK_ID),
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
    env.DB.prepare(EXPIRE_ACTIVE_WORKER_SQL).bind(
      now,
      now,
      ARTWORK_ID,
      now,
    ),
  ]);
}

type WorkerHeartbeat = {
  checkpoint: () => Promise<void>;
  stop: () => Promise<void>;
};

function startWorkerHeartbeat(env: AppEnv, job: QueueJob): WorkerHeartbeat {
  let stopped = false;
  let lostLease: DomainError | null = null;
  let inFlight: Promise<void> | null = null;

  const heartbeat = () => {
    if (stopped || inFlight) return;
    const now = Date.now();
    inFlight = retryIdempotentD1(() =>
      env.DB.prepare(RENEW_WORKER_LEASE_SQL)
        .bind(
          now,
          now + WORKER_LEASE_MS,
          job.id,
          ARTWORK_ID,
          job.workerToken,
          job.leaseFence,
          now,
        )
        .run(),
    )
      .then((result) => {
        if (Number(result.meta.changes ?? 0) === 0) {
          lostLease = new DomainError(
            "QUEUE_LEASE_EXPIRED",
            "The generation worker lost its reservation before finishing.",
          );
        }
      })
      .catch(() => {
        lostLease = new DomainError(
          "SERVICE_UNAVAILABLE",
          "The generation worker could not renew its reservation.",
        );
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(heartbeat, WORKER_HEARTBEAT_MS);
  return {
    checkpoint: async () => {
      const pending = inFlight;
      if (pending) await pending;
      if (lostLease) throw lostLease;
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      const pending = inFlight;
      if (pending) await pending;
    },
  };
}

async function processClaimedJob(env: AppEnv, job: QueueJob) {
  let heartbeat: WorkerHeartbeat | null = null;
  try {
    if (job.kind === "revert") {
      await commitRevert(env, job);
      return;
    }

    if (!job.displayMaskBlobId) {
      throw new DomainError("INTERNAL_ERROR", "The generated layer mask is missing.");
    }

    if (job.executionMode !== "openai") {
      throw new DomainError(
        "INTERNAL_ERROR",
        "This queued edit uses a retired contribution format.",
      );
    }

    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new DomainError(
        "AI_CONFIGURATION_ERROR",
        "Live AI editing is not configured. Nothing was added to history.",
      );
    }
    const region = jobRegion(job);
    const frame = jobFrame(job);
    const generationRegion = regionInGenerationFrame(region, frame);
    heartbeat = startWorkerHeartbeat(env, job);
    await updateStage(env, job, "moderating", "generating");
    const patch = await generateOpenAiPatch(
      env,
      job,
      apiKey,
      job.prompt,
    );
    await heartbeat.checkpoint();
    await updateStage(env, job, "generating", "generating");
    const reviewResult = await reviewEditOutput(
      job.id,
      apiKey,
      job.prompt,
      patch.bytes,
      patch.sourceBytes,
      patch.providerMaskBytes,
      patch.referenceBytes,
      generationRegion,
    );
    await heartbeat.checkpoint();
    if (reviewResult.status === "reviewed") {
      const review = reviewResult.review;
      console.info(`[palimpsest:${job.id}] edit output review`, {
        referenceGuided: Boolean(patch.referenceBytes),
        subjectContained: review.contained,
        surroundingsBlended: review.blended,
        faithful: "faithful" in review ? review.faithful : null,
        placementMatched: "placementMatched" in review ? review.placementMatched : null,
        sourcePreserved: "sourcePreserved" in review ? review.sourcePreserved : null,
        reviewerReason: review.reason.slice(0, 240),
      });
      const accepted = patch.referenceBytes
        ? (
            "faithful" in review &&
            review.contained &&
            review.faithful &&
            review.placementMatched &&
            review.blended &&
            review.sourcePreserved
          )
        : review.contained && review.blended;
      if (!accepted) {
        throw new DomainError(
          patch.referenceBytes ? "REFERENCE_REVIEW_FAILED" : "SUBJECT_OUT_OF_FRAME",
          reviewFailureMessage(
            patch.referenceBytes
              ? "The generated reference did not pass the fidelity and blending check. Nothing was added to history; use retry for one fresh attempt."
              : "The generated edit did not pass the framing and blending check. Nothing was added to history; use retry for one fresh attempt.",
            review.reason,
          ),
        );
      }
    } else {
      console.warn(
        `[palimpsest:${job.id}] visual review unavailable; accepting completed image generation`,
        {
          referenceGuided: Boolean(patch.referenceBytes),
          detail: reviewResult.detail,
        },
      );
    }

    await updateStage(env, job, "generating", "committing");
    await heartbeat.stop();
    heartbeat = null;
    await commitPatch(env, job, patch);
  } catch (error) {
    if (heartbeat) await heartbeat.stop();
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
      now + WORKER_LEASE_MS,
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

async function generateOpenAiPatch(
  env: AppEnv,
  job: QueueJob,
  apiKey: string,
  requestedPrompt: string,
): Promise<{
  bytes: Uint8Array;
  contentType: string;
  providerRequestId?: string;
  sourceBytes: Uint8Array;
  providerMaskBytes: Uint8Array;
  referenceBytes: Uint8Array | null;
}> {
  if (!job.sourceBlobId || !job.maskBlobId) {
    throw new DomainError("INTERNAL_ERROR", "The image-edit inputs are missing.");
  }
  const [sourceRecord, maskRecord, referenceRecord] = await Promise.all([
    getBlobRecord(env, job.sourceBlobId),
    getBlobRecord(env, job.maskBlobId),
    job.referenceBlobId
      ? getBlobRecord(env, job.referenceBlobId)
      : Promise.resolve(null),
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
    referenceRecord
      ? env.BLOBS.get(referenceRecord.r2Key)
      : Promise.resolve(null),
  ]);
  if (!source || !mask) {
    throw new DomainError("INTERNAL_ERROR", "The image-edit inputs are no longer available.");
  }
  if (referenceRecord && !reference) {
    throw new DomainError("INTERNAL_ERROR", "The reference image is no longer available.");
  }

  const [sourceBytes, providerMaskBytes, referenceBytes] = await Promise.all([
    source.arrayBuffer().then((value) => new Uint8Array(value)),
    mask.arrayBuffer().then((value) => new Uint8Array(value)),
    reference
      ? reference.arrayBuffer().then((value) => new Uint8Array(value))
      : Promise.resolve(null),
  ]);

  const form = new FormData();
  form.append("model", "gpt-image-2");
  form.append(
    "image[]",
    new File([sourceBytes], "palimpsest-context.png", {
      type: "image/png",
    }),
  );
  form.append(
    "mask",
    new File([providerMaskBytes], "palimpsest-mask.png", {
      type: "image/png",
    }),
  );
  if (referenceBytes) {
    form.append(
      "image[]",
      new File([referenceBytes], "palimpsest-reference.png", {
        type: "image/png",
      }),
    );
  }
  form.append(
    "prompt",
    buildOpenAiEditPrompt(requestedPrompt, Boolean(referenceBytes)),
  );
  form.append("size", "1024x1024");
  form.append("quality", "medium");
  form.append("output_format", "png");
  form.append("moderation", "auto");

  let response: Response;
  let body:
    | { data?: Array<{ b64_json?: string }>; error?: { code?: string } }
    | null;
  try {
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    body = (await response.json().catch(() => null)) as
      | { data?: Array<{ b64_json?: string }>; error?: { code?: string } }
      | null;
  } catch (error) {
    console.error(`[palimpsest:${job.id}] image edit request failed`, {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown fetch failure",
    });
    throw new DomainError(
      "PROVIDER_TEMPORARY",
      "The image provider connection ended before returning an image. Nothing was added to history.",
    );
  }

  const providerRequestId = response.headers.get("x-request-id") ?? undefined;
  if (!response.ok) {
    console.error(`[palimpsest:${job.id}] image edit rejected`, {
      status: response.status,
      code: body?.error?.code ?? null,
      requestId: providerRequestId ?? null,
    });
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
  return {
    bytes,
    contentType: "image/png",
    providerRequestId,
    sourceBytes,
    providerMaskBytes,
    referenceBytes,
  };
}

function imageDataUrl(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

async function reviewEditOutput(
  jobId: string,
  apiKey: string,
  requestedChange: string,
  generatedBytes: Uint8Array,
  sourceBytes: Uint8Array,
  providerMaskBytes: Uint8Array,
  referenceBytes: Uint8Array | null,
  editableRegion: { x: number; y: number; width: number; height: number },
): Promise<EditReviewResult> {
  const requestBody = JSON.stringify(
    referenceBytes
      ? buildReferenceEditReviewRequest({
          requestedChange,
          generatedImageUrl: imageDataUrl(generatedBytes),
          sourceImageUrl: imageDataUrl(sourceBytes),
          referenceImageUrl: imageDataUrl(referenceBytes),
          providerMaskUrl: imageDataUrl(providerMaskBytes),
          editableRegion,
        })
      : buildEditOutputReviewRequest({
          requestedChange,
          generatedImageUrl: imageDataUrl(generatedBytes),
          providerMaskUrl: imageDataUrl(providerMaskBytes),
          editableRegion,
        }),
  );
  let lastDetail = "no_response";

  for (let attempt = 1; attempt <= EDIT_REVIEW_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, EDIT_REVIEW_RETRY_DELAY_MS * (attempt - 1));
      });
    }

    let response: Response;
    let body: Record<string, unknown> | null;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: requestBody,
      });
      body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    } catch (error) {
      lastDetail = "connection_error";
      console.warn(`[palimpsest:${jobId}] visual review request failed`, {
        attempt,
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : "Unknown fetch failure",
      });
      continue;
    }

    const providerRequestId = response.headers.get("x-request-id");
    const diagnostics = describeEditReviewResponse(body);
    if (!response.ok) {
      lastDetail = `http_${response.status}`;
      console.warn(`[palimpsest:${jobId}] visual review request rejected`, {
        attempt,
        status: response.status,
        requestId: providerRequestId,
        responseId: diagnostics.responseId,
      });
      if (response.status < 500 && response.status !== 429) break;
      continue;
    }

    const review = referenceBytes
      ? extractReferenceEditReview(body)
      : extractEditOutputReview(body);
    if (review) {
      return { status: "reviewed", review };
    }

    lastDetail = diagnostics.refused
      ? "refusal"
      : diagnostics.incompleteReason ?? diagnostics.status;
    console.warn(`[palimpsest:${jobId}] visual review returned no structured result`, {
      attempt,
      requestId: providerRequestId,
      ...diagnostics,
    });
    if (diagnostics.refused) {
      throw new DomainError(
        "CONTENT_POLICY",
        "The generated image could not be accepted because its review was refused for safety.",
      );
    }
  }

  return { status: "unavailable", detail: lastDetail };
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
  AND (
    job.reference_blob_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM blobs reference
      WHERE reference.id = job.reference_blob_id
        AND reference.artwork_id = job.artwork_id
        AND reference.kind = 'input'
    )
  )
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
  const key =
    `artworks/palimpsest/patches/${revisionId}/frame-${frame.x}-${frame.y}-${hash}.png`;
  await env.BLOBS.put(key, patch.bytes, {
    httpMetadata: { contentType: patch.contentType },
    customMetadata: { sha256: hash, immutable: "true" },
  });
  const insertPatchBlob = env.DB.prepare(
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
    Date.now(),
    revisionId,
  );

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
      insertPatchBlob,
      env.DB.prepare(
        `INSERT INTO revision_patches (
           revision_id, patch_blob_id, display_mask_blob_id,
           frame_x, frame_y, frame_width, frame_height
         )
         SELECT ?, ?, ?, job.frame_x, job.frame_y, job.frame_width, job.frame_height
         FROM edit_jobs job
         JOIN blobs patch ON patch.id = ? AND patch.kind = 'patch'
         WHERE job.id = ? AND EXISTS (SELECT 1 FROM revisions WHERE id = ?)`,
      ).bind(
        revisionId,
        blobId,
        displayMaskBlobId,
        blobId,
        job.id,
        revisionId,
      ),
      env.DB.prepare(
        `UPDATE artworks
         SET head_revision_id = ?,
             head_sequence = (SELECT sequence FROM revisions WHERE id = ?)
         WHERE id = ?
           AND EXISTS (SELECT 1 FROM revisions WHERE id = ?)
           AND EXISTS (
             SELECT 1 FROM revision_patches WHERE revision_id = ?
           )
           AND head_revision_id = (
             SELECT parent_revision_id FROM revisions WHERE id = ?
           )`,
      ).bind(
        revisionId,
        revisionId,
        ARTWORK_ID,
        revisionId,
        revisionId,
        revisionId,
      ),
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
           AND EXISTS (SELECT 1 FROM revisions WHERE id = ?)
           AND EXISTS (
             SELECT 1 FROM revision_patches WHERE revision_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM artworks
             WHERE id = ? AND head_revision_id = ?
           )`,
      ).bind(
        revisionId,
        patch.providerRequestId ?? null,
        now,
        now,
        job.id,
        job.workerToken,
        job.leaseFence,
        revisionId,
        revisionId,
        ARTWORK_ID,
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
    if (
      Number(committed[1]?.meta.changes ?? 0) !== 1 ||
      Number(committed[2]?.meta.changes ?? 0) !== 1 ||
      Number(committed[3]?.meta.changes ?? 0) !== 1 ||
      Number(committed[4]?.meta.changes ?? 0) !== 1
    ) {
      throw new DomainError(
        "INTERNAL_ERROR",
        "The accepted patch could not be committed completely.",
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
  const state =
    domain?.code === "STALE_BASE_REVISION"
      ? "stale"
      : domain?.code === "CONTENT_POLICY"
        ? "rejected"
        : "failed";
  const code = domain?.code ?? "INTERNAL_ERROR";
  const message =
    domain?.message ?? "The edit could not be completed. Nothing was added to history.";
  await env.DB.prepare(FAIL_CLAIMED_JOB_SQL)
    .bind(
      state,
      code,
      message,
      now,
      now,
      job.id,
      job.workerToken,
      job.leaseFence,
    )
    .run();
}
