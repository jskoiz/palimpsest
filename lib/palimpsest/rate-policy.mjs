import { isVerifiedAdminRequest } from "./admin.mjs";

const REGULAR_EDIT_LIMITS = Object.freeze([
  Object.freeze({ scope: "edit-10m", limit: 3, windowMs: 10 * 60 * 1000 }),
  Object.freeze({ scope: "edit-day", limit: 12, windowMs: 24 * 60 * 60 * 1000 }),
]);

export function contributionRatePolicy(env, request, kind) {
  if (kind !== "edit") throw new TypeError(`Unknown contribution kind: ${kind}`);

  if (isVerifiedAdminRequest(env, request)) {
    return { name: "admin-bypass", limits: [] };
  }

  return { name: "regular", limits: REGULAR_EDIT_LIMITS };
}
