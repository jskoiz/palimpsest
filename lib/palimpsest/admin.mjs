const AUTHENTICATED_USER_EMAIL_HEADER = "oai-authenticated-user-email";

function normalizedAllowlist(value) {
  if (typeof value !== "string") return new Set();
  return new Set(
    value
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Sites dispatch owns the authenticated-user header. Authorization remains
 * server-side: a missing identity or allowlist always fails closed.
 */
export function isVerifiedAdminRequest(env, request) {
  const email = request.headers
    .get(AUTHENTICATED_USER_EMAIL_HEADER)
    ?.trim()
    .toLowerCase();
  if (!email) return false;

  return normalizedAllowlist(env.ADMIN_EMAIL_ALLOWLIST).has(email);
}
