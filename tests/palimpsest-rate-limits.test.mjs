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

test("debug endpoint is intentionally public and contains no client-controlled bypass", async () => {
  const source = await readFile(
    new URL("../app/api/debug/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /getDebugSnapshot\(getRuntimeEnv\(\), request\.url\)/u);
  assert.doesNotMatch(source, /isVerifiedAdminRequest/u);
  assert.doesNotMatch(source, /status:\s*403/u);
  assert.doesNotMatch(source, /x-palimpsest-admin/i);
});

test("public visitor events are bounded before storage", async () => {
  const [route, store] = await Promise.all([
    readFile(new URL("../app/api/visitors/events/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/palimpsest/store.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /application\/json/u);
  assert.match(route, /PAYLOAD_TOO_LARGE/u);
  assert.match(store, /VISITOR_EVENT_LIMIT_WINDOW_MS/u);
  assert.match(store, /VISITOR_EVENT_RETENTION_MS/u);
  assert.match(store, /WHERE NOT EXISTS/u);
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
