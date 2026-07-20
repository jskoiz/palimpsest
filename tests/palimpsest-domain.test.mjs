import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ARTWORK_SIZE,
  DomainError,
  assertFreshBase,
  buildOpenAiEditPrompt,
  createDisplayMaskSvg,
  displayMaskForLayer,
  maskBlendInset,
  resolveLayerStack,
  serializeHistory,
  validateRegion,
} from "../lib/palimpsest/domain.mjs";
import {
  canvasPanBounds,
  canvasViewCanPan,
  constrainCanvasView,
  generationFrameForRegion,
  nudgeEditRegion,
  positionEditRegion,
  regionRelativeToFrame,
  regionsOverlap,
  timelineIndexAtPosition,
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
    },
  ];

  assert.deepEqual(
    serializeHistory(rows).map((revision) => revision.id),
    ["r0", "r1", "r2"],
  );
});

test("global region constraints accept seam crossing and every artwork boundary", () => {
  const seamCrossing = validateRegion({
    region: { x: 900, y: 900, width: 256, height: 256 },
    fill: true,
    strokes: [],
  });
  assert.deepEqual(seamCrossing.region, {
    x: 900,
    y: 900,
    width: 256,
    height: 256,
  });

  const boundaryRegions = [
    { x: 0, y: 700, width: 64, height: 64 },
    { x: 700, y: 0, width: 64, height: 64 },
    { x: ARTWORK_SIZE - 64, y: 700, width: 64, height: 64 },
    { x: 700, y: ARTWORK_SIZE - 64, width: 64, height: 64 },
  ];
  for (const region of boundaryRegions) {
    assert.deepEqual(validateRegion({ region, fill: true }).region, region);
  }

  const outsideRegions = [
    { x: -1, y: 700, width: 64, height: 64 },
    { x: 700, y: -1, width: 64, height: 64 },
    { x: ARTWORK_SIZE - 63, y: 700, width: 64, height: 64 },
    { x: 700, y: ARTWORK_SIZE - 63, width: 64, height: 64 },
  ];
  for (const region of outsideRegions) {
    expectCode(() => validateRegion({ region, fill: true }), "REGION_OUT_OF_BOUNDS");
  }
});

test("region constraints reject legacy tile fields and unsafe masks", () => {
  expectCode(
    () =>
      validateRegion({
        tile: { x: 0, y: 0 },
        region: { x: 0, y: 0, width: 128, height: 128 },
        fill: true,
      }),
    "INVALID_REQUEST",
  );
  expectCode(
    () =>
      validateRegion({
        region: { x: 0, y: 0, width: 128, height: 128, tile: { x: 0, y: 0 } },
        fill: true,
      }),
    "INVALID_REQUEST",
  );

  for (const region of [
    { x: 0, y: 0, width: 63, height: 64 },
    { x: 0, y: 0, width: 64, height: 63 },
    { x: 0, y: 0, width: 513, height: 64 },
    { x: 0, y: 0, width: 64, height: 513 },
  ]) {
    expectCode(() => validateRegion({ region, fill: true }), "REGION_OUT_OF_BOUNDS");
  }

  expectCode(
    () =>
      validateRegion({
        region: { x: 0, y: 0, width: 512, height: 257 },
        fill: true,
      }),
    "MASK_TOO_LARGE",
  );
  expectCode(
    () =>
      validateRegion({
        region: { x: 0, y: 0, width: 128, height: 128 },
        fill: false,
        strokes: [],
      }),
    "MASK_EMPTY",
  );
  expectCode(
    () =>
      validateRegion({
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

test("generated layers retain the reservation mask", () => {
  assert.equal(displayMaskForLayer("openai", "display-mask"), "display-mask");
  assert.equal(displayMaskForLayer("demo", "display-mask"), "display-mask");
  assert.equal(displayMaskForLayer("openai", null), null);
  assert.equal(displayMaskForLayer("seed", "unexpected-mask"), null);
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
      regionX: 1036,
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
    x: 1036,
    y: 24,
    width: 320,
    height: 256,
  });
  assert.equal("workerToken" in revision, false);
  assert.equal("r2Key" in revision, false);
  assert.equal("openaiKey" in revision, false);
});

test("global layer stacks preserve revert history without mutating inputs", () => {
  const revisions = [
    { id: "r4", sequence: 4, origin: "openai" },
    { id: "r2", sequence: 2, origin: "openai" },
    { id: "r0", sequence: 0, origin: "seed" },
    { id: "r3", sequence: 3, origin: "revert", revertTargetRevisionId: "r1" },
    { id: "r1", sequence: 1, origin: "demo" },
  ];
  const layers = [
    { revisionId: "r1", frame: { x: 0, y: 0, width: 1024, height: 1024 }, blobId: "p1" },
    { revisionId: "r2", frame: { x: 512, y: 512, width: 1024, height: 1024 }, blobId: "p2" },
    { revisionId: "r4", frame: { x: 1024, y: 1024, width: 1024, height: 1024 }, blobId: "p4" },
  ];
  const stack = resolveLayerStack(revisions, layers);
  assert.deepEqual(stack.map((layer) => layer.blobId), ["p1", "p4"]);
  assert.deepEqual(layers.map((layer) => layer.blobId), ["p1", "p2", "p4"]);
});

test("patch positioning follows the pointer continuously across seams", () => {
  const region = { x: 320, y: 352, width: 384, height: 320 };

  assert.deepEqual(positionEditRegion(region, 48, 72), {
    x: 48,
    y: 72,
    width: 384,
    height: 320,
  });
  assert.deepEqual(positionEditRegion(region, 930, 980), {
    x: 930,
    y: 980,
    width: 384,
    height: 320,
  });
  assert.deepEqual(positionEditRegion(region, -200, 2400), {
    x: 0,
    y: 1728,
    width: 384,
    height: 320,
  });
});

test("keyboard nudging crosses seams without snapping or escaping the artwork", () => {
  const atSeams = { x: 640, y: 704, width: 384, height: 320 };
  assert.deepEqual(nudgeEditRegion(atSeams, 8, 8), {
    x: 648,
    y: 712,
    width: 384,
    height: 320,
  });

  const artworkEdge = { x: 1664, y: 1728, width: 384, height: 320 };
  assert.deepEqual(nudgeEditRegion(artworkEdge, 32, 32), artworkEdge);
});

test("generation frames center seam-crossing regions and clamp at every artwork edge", () => {
  assert.deepEqual(
    generationFrameForRegion({ x: 896, y: 832, width: 256, height: 384 }),
    { x: 512, y: 512, width: 1024, height: 1024 },
  );

  const corners = [
    [{ x: 0, y: 0, width: 64, height: 64 }, { x: 0, y: 0, width: 1024, height: 1024 }],
    [{ x: 1984, y: 0, width: 64, height: 64 }, { x: 1024, y: 0, width: 1024, height: 1024 }],
    [{ x: 0, y: 1984, width: 64, height: 64 }, { x: 0, y: 1024, width: 1024, height: 1024 }],
    [{ x: 1984, y: 1984, width: 64, height: 64 }, { x: 1024, y: 1024, width: 1024, height: 1024 }],
  ];
  for (const [region, expectedFrame] of corners) {
    assert.deepEqual(generationFrameForRegion(region), expectedFrame);
  }
});

test("global regions convert to frame-local mask coordinates", () => {
  const region = { x: 896, y: 832, width: 256, height: 384 };
  const frame = generationFrameForRegion(region);
  const frameLocalRegion = regionRelativeToFrame(region, frame);
  assert.deepEqual(frameLocalRegion, { x: 384, y: 320, width: 256, height: 384 });
  assert.deepEqual(regionRelativeToFrame(region), frameLocalRegion);

  const svg = createDisplayMaskSvg({
    region: frameLocalRegion,
    fill: true,
    strokes: [],
  });
  assert.match(svg, /<rect x="384" y="320" width="256" height="384"\/>/);
});

test("region overlap requires positive shared area", () => {
  const leftHalf = { x: 0, y: 0, width: 1024, height: 2048 };
  const rightHalf = { x: 1024, y: 0, width: 1024, height: 2048 };
  const seamCrossing = { x: 900, y: 800, width: 256, height: 256 };

  assert.equal(regionsOverlap(leftHalf, rightHalf), false);
  assert.equal(regionsOverlap(leftHalf, seamCrossing), true);
  assert.equal(regionsOverlap(rightHalf, seamCrossing), true);
  assert.equal(
    regionsOverlap(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 9, y: 9, width: 10, height: 10 },
    ),
    true,
  );
  assert.equal(
    regionsOverlap(
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: 10 },
    ),
    false,
  );
});

test("portrait cover canvases pan horizontally at base zoom without exposing gaps", () => {
  assert.deepEqual(canvasPanBounds(390, 844, 1), {
    minX: -227,
    maxX: 227,
    minY: 0,
    maxY: 0,
  });
  assert.equal(canvasViewCanPan({ zoom: 1 }, 390, 844), true);
  assert.deepEqual(constrainCanvasView({ zoom: 1, x: 500, y: 80 }, 390, 844), {
    zoom: 1,
    x: 227,
    y: 0,
  });
});

test("landscape and zoomed square canvases stay bounded on every hidden axis", () => {
  assert.deepEqual(constrainCanvasView({ zoom: 1, x: -20, y: -500 }, 844, 390), {
    zoom: 1,
    x: 0,
    y: -227,
  });
  assert.equal(canvasViewCanPan({ zoom: 1 }, 800, 800), false);
  assert.equal(canvasViewCanPan({ zoom: 2 }, 800, 800), true);
  assert.deepEqual(constrainCanvasView({ zoom: 2, x: 900, y: -900 }, 800, 800), {
    zoom: 2,
    x: 0,
    y: -800,
  });
});

test("timeline dragging selects the nearest revision and clamps to the track", () => {
  assert.equal(timelineIndexAtPosition(100, 100, 800, 9), 0);
  assert.equal(timelineIndexAtPosition(500, 100, 800, 9), 4);
  assert.equal(timelineIndexAtPosition(900, 100, 800, 9), 8);
  assert.equal(timelineIndexAtPosition(-200, 100, 800, 9), 0);
  assert.equal(timelineIndexAtPosition(1_400, 100, 800, 9), 8);
  assert.equal(timelineIndexAtPosition(500, 100, 0, 9), 0);
  assert.equal(timelineIndexAtPosition(500, 100, 800, 1), 0);
});
