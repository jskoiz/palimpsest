export const WORKER_LEASE_MS = 60_000;
export const WORKER_HEARTBEAT_MS = 15_000;
export const WORKER_TOTAL_BUDGET_MS = 180_000;
export const IMAGE_EDIT_TIMEOUT_MS = 120_000;
export const EDIT_REVIEW_TIMEOUT_MS = 45_000;

/**
 * Keep every provider stage inside the remaining worker budget.
 *
 * @param {number} deadlineAt
 * @param {number} stageLimitMs
 * @param {number} [now]
 */
export function boundedStageTimeout(deadlineAt, stageLimitMs, now = Date.now()) {
  const remaining = Math.max(0, Math.floor(deadlineAt - now));
  return Math.min(Math.max(0, Math.floor(stageLimitMs)), remaining);
}
