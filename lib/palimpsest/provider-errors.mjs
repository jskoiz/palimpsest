const GENERATION_CREDIT_CODES = new Set([
  "billing_hard_limit_reached",
  "billing_not_active",
  "credits_exhausted",
  "insufficient_quota",
  "usage_limit_reached",
]);

const BILLING_RESPONSE_STATUSES = new Set([400, 402, 403, 429]);
const BILLING_MESSAGE =
  /\b(?:add to balance|balance (?:is )?(?:depleted|empty)|billing quota|credit balance|credits? exhausted|insufficient quota|no credits remaining|run out of credits|usage limit)\b/u;

function normalizedErrorValue(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Distinguish a durable account-credit outage from a short-lived rate limit.
 * The explicit provider code/type is authoritative. Message matching is kept
 * behind billing-adjacent HTTP statuses for provider responses that omit a
 * machine-readable code.
 *
 * @param {number} status
 * @param {{ code?: unknown, type?: unknown, message?: unknown } | null | undefined} error
 */
export function isGenerationCreditExhaustion(status, error) {
  const code = normalizedErrorValue(error?.code);
  const type = normalizedErrorValue(error?.type);
  if (GENERATION_CREDIT_CODES.has(code) || GENERATION_CREDIT_CODES.has(type)) {
    return true;
  }
  const message = normalizedErrorValue(error?.message);
  return BILLING_RESPONSE_STATUSES.has(status) && BILLING_MESSAGE.test(message);
}
