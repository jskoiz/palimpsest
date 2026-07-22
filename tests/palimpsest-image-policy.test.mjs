import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { imageEditProviderPolicy } from "../lib/palimpsest/image-edit-policy.mjs";

test("reference edits use a model that supports transparent high-fidelity output", () => {
  assert.deepEqual(imageEditProviderPolicy(true), {
    model: "gpt-image-1.5",
    background: "transparent",
    inputFidelity: "high",
  });
});

test("GPT Image 2 edits omit its unsupported transparency and fidelity fields", () => {
  assert.deepEqual(imageEditProviderPolicy(false), {
    model: "gpt-image-2",
    background: null,
    inputFidelity: null,
  });
});

test("the live queue applies the centralized provider policy", async () => {
  const queueSource = await readFile(
    new URL("../lib/palimpsest/queue.ts", import.meta.url),
    "utf8",
  );

  assert.match(queueSource, /imageEditProviderPolicy\(Boolean\(referenceBytes\)\)/);
  assert.match(queueSource, /form\.append\("model", imagePolicy\.model\)/);
  assert.match(queueSource, /if \(imagePolicy\.background\)/);
  assert.match(queueSource, /if \(imagePolicy\.inputFidelity\)/);
  assert.doesNotMatch(queueSource, /form\.append\("model", "gpt-image-2"\)/);
});
