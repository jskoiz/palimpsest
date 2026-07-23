const RETRYABLE_D1_RESET_PATTERNS = [
  /storage operation exceeded timeout which caused object to be reset/iu,
  /storage caused object to be reset/iu,
  /d1 db.*object.*reset/iu,
];

export function isRetryableD1Reset(error) {
  const messages = [];
  let current = error;
  for (let depth = 0; depth < 4 && current != null; depth += 1) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = typeof current === "object" && "cause" in current ? current.cause : null;
  }
  return messages.some((message) =>
    RETRYABLE_D1_RESET_PATTERNS.some((pattern) => pattern.test(message)),
  );
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Retry only a caller-declared idempotent D1 operation. This helper deliberately
 * recognizes the narrow storage-reset failure instead of retrying arbitrary writes.
 */
export async function retryIdempotentD1(operation, options = {}) {
  // A D1 storage reset can itself consume ~30 seconds, so one replay is the
  // bounded server-side recovery; the client handles any later retry after 503.
  const attempts = Math.max(1, Math.min(3, Number(options.attempts ?? 2)));
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs ?? 150));
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isRetryableD1Reset(error) || attempt === attempts - 1) throw error;
      const exponential = baseDelayMs * 2 ** attempt;
      const jitter = Math.floor(exponential * 0.5 * random());
      await sleep(exponential + jitter);
    }
  }
  throw new Error("unreachable D1 retry state");
}
