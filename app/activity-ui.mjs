const ACTIVE_JOB_STATES = new Set([
  "queued",
  "moderating",
  "generating",
  "committing",
]);

const FAILED_JOB_STATES = new Set(["failed", "rejected", "stale"]);

/**
 * Convert internal worker states into the small, stable vocabulary shown to
 * visitors. A lapsed lease is recovery work until the worker reaches a
 * terminal state; it must not look like a healthy reservation.
 *
 * @param {{ state: string, reservationActive: boolean }} job
 */
export function activityJobState(job) {
  if (job.state === "succeeded") return "done";
  if (FAILED_JOB_STATES.has(job.state)) return "failed";
  if (!job.reservationActive && ACTIVE_JOB_STATES.has(job.state)) return "recovering";
  if (job.state === "queued") return "reserved";
  if (job.state === "moderating") return "starting";
  if (job.state === "generating") return "generating";
  if (job.state === "committing") return "finishing";
  return "recovering";
}

/** @param {{ state: string, reservationActive: boolean }} job */
export function activityJobIsInProcess(job) {
  const state = activityJobState(job);
  return state !== "done" && state !== "failed";
}

/** @param {{ state: string, reservationActive: boolean }} job */
export function activityJobNeedsAttention(job) {
  return activityJobState(job) === "failed";
}

/**
 * Summarize durable job entries without treating failed work as in process.
 *
 * @param {Array<{ state: string, reservationActive: boolean }>} jobs
 */
export function activityJobCounts(jobs) {
  let inProcess = 0;
  let failed = 0;
  let done = 0;
  for (const job of jobs) {
    if (activityJobIsInProcess(job)) inProcess += 1;
    else if (activityJobNeedsAttention(job)) failed += 1;
    else done += 1;
  }
  return { inProcess, failed, done };
}

/**
 * Exponential recovery delay with bounded jitter. Supplying randomValue keeps
 * the helper deterministic in tests while production passes Math.random().
 *
 * @param {number} attempt
 * @param {number} [randomValue]
 */
export function queueRecoveryDelay(attempt, randomValue = Math.random()) {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const base = Math.min(60_000, 12_000 * 2 ** safeAttempt);
  const random = Number.isFinite(randomValue)
    ? Math.max(0, Math.min(1, randomValue))
    : 0.5;
  return Math.round(base * (0.85 + random * 0.3));
}

/**
 * Poll quickly while collaborative work is changing and gently while idle.
 * Hidden tabs remain useful for recovery without matching foreground traffic.
 *
 * @param {boolean} hasWork
 * @param {boolean} hidden
 * @param {number} [randomValue]
 */
export function collaborationPollDelay(
  hasWork,
  hidden,
  randomValue = Math.random(),
) {
  const base = hidden ? (hasWork ? 8_000 : 30_000) : hasWork ? 3_000 : 15_000;
  const random = Number.isFinite(randomValue)
    ? Math.max(0, Math.min(1, randomValue))
    : 0.5;
  return Math.round(base * (0.88 + random * 0.24));
}

/**
 * Center an artwork-space region in the unobscured upper part of the viewport.
 * The caller applies the shared canvas constraints before rendering.
 *
 * @param {{ x: number, y: number, width: number, height: number }} region
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @param {number} artworkSize
 */
export function viewForActivityRegion(
  region,
  viewportWidth,
  viewportHeight,
  artworkSize,
) {
  const width = Math.max(0, viewportWidth);
  const height = Math.max(0, viewportHeight);
  const canvasSize = Math.max(width, height);
  const zoom = 1.65;
  if (canvasSize === 0 || artworkSize <= 0) return { zoom, x: 0, y: 0 };

  const coverLeft = (width - canvasSize) / 2;
  const coverTop = (height - canvasSize) / 2;
  const regionCenterX = region.x + region.width / 2;
  const regionCenterY = region.y + region.height / 2;
  const canvasCenterX = coverLeft + (regionCenterX / artworkSize) * canvasSize;
  const canvasCenterY = coverTop + (regionCenterY / artworkSize) * canvasSize;

  return {
    zoom,
    x: width / 2 - zoom * canvasCenterX,
    y: height * 0.38 - zoom * canvasCenterY,
  };
}
