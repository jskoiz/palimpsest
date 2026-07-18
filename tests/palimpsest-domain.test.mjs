import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DomainError,
  assertFreshBase,
  buildOpenAiEditPrompt,
  createDisplayMaskSvg,
  displayMaskForLayer,
  maskBlendInset,
  resolveTileLayers,
  serializeHistory,
  validateRegion,
} from "../lib/palimpsest/domain.mjs";
import {
  nudgeEditRegion,
  positionEditRegion,
} from "../lib/palimpsest/geometry.mjs";

function expectCode(callback, code) {
  assert.throws(callback, (error) => error instanceof DomainError && error.code === code);
}

test("revision ordering uses immutable sequence rather than timestamps", () => {
  const rows = [
    {
      id: "r2",
      sequence: 2,
      parentRevisionId: "r1",
      displayName: "Second",
      prompt: "Second change",
      createdAt: 10,
      origin: "demo",
      regionX: 0,
      regionY: 0,
      regionWidth: 128,
      regionHeight: 128,
      tileX: 1,
      tileY: 0,
    },
    {
      id: "r0",
      sequence: 0,
      parentRevisionId: null,
      displayName: "Archive",
      prompt: "First ground",
      createdAt: 999_999,
      origin: "seed",
      regionX: null,
      revertTargetRevisionId: null,
    },
    {
      id: "r1",
      sequence: 1,
      parentRevisionId: "r0",
      displayName: "First",
      prompt: "First change",
      createdAt: 10,
      origin: "openai",
      regionX: 10,
      regionY: 20,
      regionWidth: 256,
      regionHeight: 256,
      tileX: 0,
      tileY: 0,
    },
  ];

  assert.deepEqual(
    serializeHistory(rows).map((revision) => revision.id),
    ["r0", "r1", "r2"],
  );
});

test("region constraints accept exact boundaries and reject unsafe masks", () => {
  const boundary = validateRegion({
    tile: { x: 1, y: 1 },
    region: { x: 512, y: 768, width: 512, height: 256 },
    fill: true,
    strokes: [],
  });
  assert.deepEqual(boundary.region, { x: 512, y: 768, width: 512, height: 256 });

  expectCode(
    () =>
      validateRegion({
        tile: { x: 0, y: 0 },
        region: { x: 0, y: 0, width: 512, height: 257 },
        fill: true,
      }),
    "MASK_TOO_LARGE",
  );
  expectCode(
    () =>
      validateRegion({
        tile: { x: 0, y: 0 },
        region: { x: 900, y: 0, width: 128, height: 128 },
        fill: true,
      }),
    "REGION_OUT_OF_BOUNDS",
  );
  expectCode(
    () =>
      validateRegion({
        tile: { x: 0, y: 0 },
        region: { x: 0, y: 0, width: 128, height: 128 },
        fill: false,
        strokes: [],
      }),
    "MASK_EMPTY",
  );
  expectCode(
    () =>
      validateRegion({
        tile: { x: 0, y: 0 },
        region: { x: 0, y: 0, width: 128, height: 128 },
        strokes: [{ width: 16, points: [{ x: 129, y: 20 }] }],
      }),
    "REGION_OUT_OF_BOUNDS",
  );
});

test("filled object masks reserve a feathered blend margin", () => {
  const region = { x: 100, y: 200, width: 384, height: 320 };
  assert.equal(maskBlendInset(region), 24);
  assert.equal(maskBlendInset({ width: 64, height: 64 }), 24);

  const svg = createDisplayMaskSvg({ region, fill: true, strokes: [] });
  assert.match(svg, /feGaussianBlur stdDeviation="10"/);
  assert.match(svg, /clipPath id="edit-bounds"/);
  assert.match(svg, /<rect x="124" y="224" width="336" height="272" fill="white"\/>/);
});

test("live image patches render as complete replacement tiles", () => {
  assert.equal(displayMaskForLayer("openai", "display-mask"), null);
  assert.equal(displayMaskForLayer("demo", "display-mask"), "display-mask");
  assert.equal(displayMaskForLayer("seed", null), null);
});

test("request handlers rely on packaged migrations instead of runtime schema DDL", async () => {
  const storeSource = await readFile(
    new URL("../lib/palimpsest/store.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(storeSource, /CREATE\s+(?:TABLE|INDEX|TRIGGER)/i);
});

test("live image prompts keep random objects whole without forcing an art style", () => {
  const prompt = buildOpenAiEditPrompt("Add a bright plastic toy truck.");
  assert.match(prompt, /entire subject comfortably inside the editable area/i);
  assert.match(prompt, /Never crop, truncate/i);
  assert.match(prompt, /without forcing it into a predefined artistic motif/i);
  assert.match(prompt, /Add a bright plastic toy truck\./);
  assert.doesNotMatch(prompt, /vermilion|graphite|mixed-media/i);
});

test("stale base revisions are rejected without an implicit rebase", () => {
  assert.equal(assertFreshBase("head-7", "head-7"), true);
  expectCode(() => assertFreshBase("head-6", "head-7"), "STALE_BASE_REVISION");
});

test("history serialization is stable, shareable, unicode-safe, and secret-free", () => {
  const [revision] = serializeHistory([
    {
      id: "révision-1",
      sequence: 1,
      parentRevisionId: "r0",
      displayName: "Noor ʻĀina",
      prompt: "Add a vermilion thread <without rewriting history>.",
      createdAt: Date.UTC(2026, 6, 17, 21, 30),
      origin: "demo",
      regionX: 12,
      regionY: 24,
      regionWidth: 320,
      regionHeight: 256,
      tileX: 1,
      tileY: 0,
      revertTargetRevisionId: null,
      workerToken: "must-not-leak",
      r2Key: "must-not-leak",
      openaiKey: "must-not-leak",
    },
  ]);

  assert.equal(revision.author, "Noor ʻĀina");
  assert.equal(revision.createdAt, "2026-07-17T21:30:00.000Z");
  assert.equal(revision.sharePath, "/?revision=r%C3%A9vision-1");
  assert.deepEqual(revision.region, {
    x: 12,
    y: 24,
    width: 320,
    height: 256,
    tile: { x: 1, y: 0 },
  });
  assert.equal("workerToken" in revision, false);
  assert.equal("r2Key" in revision, false);
  assert.equal("openaiKey" in revision, false);
});

test("revert creates a new snapshot state without mutating its target", () => {
  const baseTiles = [
    { tileX: 0, tileY: 0, blobId: "base-00" },
    { tileX: 1, tileY: 0, blobId: "base-10" },
    { tileX: 0, tileY: 1, blobId: "base-01" },
    { tileX: 1, tileY: 1, blobId: "base-11" },
  ];
  const revisions = [
    { id: "r0", sequence: 0, origin: "seed" },
    { id: "r1", sequence: 1, origin: "demo" },
    { id: "r2", sequence: 2, origin: "openai" },
    { id: "r3", sequence: 3, origin: "revert", revertTargetRevisionId: "r1" },
  ];
  const patches = [
    { revisionId: "r1", tileX: 0, tileY: 0, blobId: "p1" },
    { revisionId: "r2", tileX: 0, tileY: 0, blobId: "p2" },
  ];
  const tiles = resolveTileLayers(revisions, baseTiles, patches);
  assert.deepEqual(tiles[0].layers.map((layer) => layer.blobId), ["p1"]);
  assert.deepEqual(patches.map((patch) => patch.blobId), ["p1", "p2"]);
});

test("patch positioning follows the pointer while remaining inside one tile", () => {
  const region = {
    tile: { x: 0, y: 0 },
    region: { x: 320, y: 352, width: 384, height: 320 },
  };

  assert.deepEqual(positionEditRegion(region, 48, 72), {
    tile: { x: 0, y: 0 },
    region: { x: 48, y: 72, width: 384, height: 320 },
  });
  assert.deepEqual(positionEditRegion(region, 930, 980), {
    tile: { x: 1, y: 1 },
    region: { x: 0, y: 0, width: 384, height: 320 },
  });
  assert.deepEqual(positionEditRegion(region, -200, 2400), {
    tile: { x: 0, y: 1 },
    region: { x: 0, y: 704, width: 384, height: 320 },
  });
});

test("keyboard nudging crosses tile seams without escaping the artwork", () => {
  const rightEdge = {
    tile: { x: 0, y: 0 },
    region: { x: 640, y: 704, width: 384, height: 320 },
  };
  assert.deepEqual(nudgeEditRegion(rightEdge, 8, 8), {
    tile: { x: 1, y: 1 },
    region: { x: 0, y: 0, width: 384, height: 320 },
  });

  const artworkEdge = {
    tile: { x: 1, y: 1 },
    region: { x: 640, y: 704, width: 384, height: 320 },
  };
  assert.deepEqual(nudgeEditRegion(artworkEdge, 32, 32), artworkEdge);
});
