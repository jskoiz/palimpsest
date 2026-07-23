import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isVerifiedAdminRequest } from "../lib/palimpsest/admin.mjs";
import { contributionRatePolicy } from "../lib/palimpsest/rate-policy.mjs";

const adminEnv = {
  ADMIN_EMAIL_ALLOWLIST: " owner@example.com,SECOND@example.com ",
};

function requestWithHeaders(headers = {}) {
  return new Request("https://palimpsest.example/api/reverts", { headers });
}

test("only an exact dispatcher-authenticated allowlist identity is an admin", () => {
  assert.equal(
    isVerifiedAdminRequest(
      adminEnv,
      requestWithHeaders({ "oai-authenticated-user-email": "OWNER@example.com" }),
    ),
    true,
  );
  assert.equal(
    isVerifiedAdminRequest(
      adminEnv,
      requestWithHeaders({ "oai-authenticated-user-email": "second@example.com" }),
    ),
    true,
  );

  for (const request of [
    requestWithHeaders(),
    requestWithHeaders({ "oai-authenticated-user-email": "attacker@example.com" }),
    requestWithHeaders({ "oai-authenticated-user-email": "owner@example.com.attacker.test" }),
    requestWithHeaders({ "x-palimpsest-admin": "true" }),
  ]) {
    assert.equal(isVerifiedAdminRequest(adminEnv, request), false);
  }

  assert.equal(
    isVerifiedAdminRequest(
      {},
      requestWithHeaders({ "oai-authenticated-user-email": "owner@example.com" }),
    ),
    false,
  );
});

test("verified admins bypass every edit and restore limit", () => {
  const request = requestWithHeaders({
    "oai-authenticated-user-email": "owner@example.com",
  });

  for (const kind of ["edit", "revert"]) {
    assert.deepEqual(contributionRatePolicy(adminEnv, request, kind), {
      name: "admin-bypass",
      limits: [],
    });
  }
});

test("visitor activity endpoint relies on the dispatcher-authenticated admin gate", async () => {
  const source = await readFile(
    new URL("../app/api/visitors/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /isVerifiedAdminRequest\(env, request\)/u);
  assert.match(source, /status:\s*403/u);
  assert.doesNotMatch(source, /x-palimpsest-admin/i);
});

test("both contribution routes consume the centralized server policy", async () => {
  const [editRoute, revertRoute] = await Promise.all([
    readFile(new URL("../app/api/edits/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reverts/route.ts", import.meta.url), "utf8"),
  ]);

  for (const route of [editRoute, revertRoute]) {
    assert.match(route, /contributionRatePolicy\(env, request, "(?:edit|revert)"\)/);
    assert.match(route, /rateLimits: ratePolicy\.limits/);
    assert.doesNotMatch(route, /enforceRateLimit/);
    assert.doesNotMatch(route, /x-palimpsest-admin/i);
  }
});

test("regular restores allow two attempts per ten-minute window", async () => {
  assert.deepEqual(contributionRatePolicy(adminEnv, requestWithHeaders(), "revert"), {
    name: "regular",
    limits: [{ scope: "revert-10m", limit: 2, windowMs: 10 * 60 * 1000 }],
  });

  const revertRoute = await readFile(
    new URL("../app/api/reverts/route.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(revertRoute, /revert-hour|60 \* 60 \* 1000/);
  assert.match(revertRoute, /Retry-After", "600"/);
});

test("unknown contribution kinds cannot silently inherit another policy", () => {
  for (const request of [
    requestWithHeaders(),
    requestWithHeaders({ "oai-authenticated-user-email": "owner@example.com" }),
  ]) {
    assert.throws(
      () => contributionRatePolicy(adminEnv, request, "unknown"),
      /Unknown contribution kind/,
    );
  }
});
