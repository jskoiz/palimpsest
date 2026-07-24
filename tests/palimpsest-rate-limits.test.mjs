import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isVerifiedAdminRequest } from "../lib/palimpsest/admin.mjs";
import { contributionRatePolicy } from "../lib/palimpsest/rate-policy.mjs";

const adminEnv = {
  ADMIN_EMAIL_ALLOWLIST: " owner@example.com,SECOND@example.com ",
};

function requestWithHeaders(headers = {}) {
  return new Request("https://palimpsest.example/api/edits", { headers });
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

test("verified admins bypass edit limits", () => {
  const request = requestWithHeaders({
    "oai-authenticated-user-email": "owner@example.com",
  });

  assert.deepEqual(contributionRatePolicy(adminEnv, request, "edit"), {
    name: "admin-bypass",
    limits: [],
  });
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

test("the edit route consumes the centralized server policy", async () => {
  const editRoute = await readFile(
    new URL("../app/api/edits/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(editRoute, /contributionRatePolicy\(env, request, "edit"\)/);
  assert.match(editRoute, /rateLimits: ratePolicy\.limits/);
  assert.doesNotMatch(editRoute, /enforceRateLimit/);
  assert.doesNotMatch(editRoute, /x-palimpsest-admin/i);
});

test("history is view-only and exposes no restore write path", async () => {
  const [client, store, queue] = await Promise.all([
    readFile(new URL("../app/Palimpsest.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/palimpsest/store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/palimpsest/queue.ts", import.meta.url), "utf8"),
  ]);

  await assert.rejects(
    readFile(new URL("../app/api/reverts/route.ts", import.meta.url), "utf8"),
    { code: "ENOENT" },
  );
  assert.doesNotMatch(client, /submitRevert|restore this look|confirm restore|\/api\/reverts/u);
  assert.doesNotMatch(store, /insertRevertJob|INSERT_REVERT_RESERVATION_SQL/u);
  assert.doesNotMatch(queue, /commitRevert|COMMIT_REVERT_REVISION_SQL/u);
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
