import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTWORK_SIZE,
  MAX_EDIT_EDGE,
} from "../lib/palimpsest/domain.mjs";
import {
  REFERENCE_PLACEMENT_MIN_EDGE,
  initialReferencePlacementRegion,
  resizeReferencePlacementRegion,
} from "../lib/palimpsest/geometry.mjs";
import {
  prepareReferencePixels,
} from "../lib/palimpsest/reference-image.mjs";

function solidRgba(width, height, [red, green, blue, alpha]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = red;
    data[offset + 1] = green;
    data[offset + 2] = blue;
    data[offset + 3] = alpha;
  }
  return data;
}

function setPixel(data, width, x, y, [red, green, blue, alpha]) {
  const offset = (y * width + x) * 4;
  data[offset] = red;
  data[offset + 1] = green;
  data[offset + 2] = blue;
  data[offset + 3] = alpha;
}

function pixel(data, width, x, y) {
  const offset = (y * width + x) * 4;
  return Array.from(data.subarray(offset, offset + 4));
}

function visiblePixelCount(data) {
  let count = 0;
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] > 8) count += 1;
  }
  return count;
}

function mascotOnDarkNavyBackground() {
  const width = 11;
  const height = 13;
  const navy = [8, 8, 24, 255];
  const blue = [48, 96, 250, 255];
  const white = [245, 250, 255, 255];
  const data = solidRgba(width, height, navy);

  for (let x = 4; x <= 6; x += 1) setPixel(data, width, x, 2, blue);
  for (let x = 3; x <= 7; x += 1) setPixel(data, width, x, 3, blue);
  for (let y = 4; y <= 7; y += 1) {
    for (let x = 2; x <= 8; x += 1) setPixel(data, width, x, y, blue);
  }
  for (let y = 8; y <= 10; y += 1) {
    for (let x = 3; x <= 7; x += 1) setPixel(data, width, x, y, blue);
  }
  for (let x = 3; x <= 4; x += 1) setPixel(data, width, x, 11, blue);
  for (let x = 6; x <= 7; x += 1) setPixel(data, width, x, 11, blue);

  // Match the opaque source background exactly. Flood fill must not erase this
  // enclosed screen merely because it shares the dominant border color.
  for (let y = 5; y <= 6; y += 1) {
    for (let x = 4; x <= 6; x += 1) setPixel(data, width, x, y, navy);
  }
  setPixel(data, width, 4, 5, white);
  setPixel(data, width, 6, 6, white);

  return { data, width, height, navy, blue };
}

function assertAspectLocked(region, aspectRatio) {
  const pixelError = Math.abs(region.width - region.height * aspectRatio);
  assert.ok(
    pixelError <= 1,
    `expected ${region.width}×${region.height} to preserve aspect ${aspectRatio}`,
  );
}

test("opaque bordered mascot references remove only edge-connected background", () => {
  const fixture = mascotOnDarkNavyBackground();
  const original = new Uint8ClampedArray(fixture.data);
  const result = prepareReferencePixels(fixture);

  assert.equal(result.backgroundRemoved, true);
  assert.deepEqual(result.bounds, { x: 2, y: 2, width: 7, height: 10 });
  assert.deepEqual(fixture.data, original, "preparation must not mutate the upload pixels");

  for (const [x, y] of [
    [0, 0],
    [fixture.width - 1, 0],
    [0, fixture.height - 1],
    [fixture.width - 1, fixture.height - 1],
  ]) {
    assert.equal(pixel(result.data, fixture.width, x, y)[3], 0);
  }

  assert.deepEqual(
    pixel(result.data, fixture.width, 5, 5),
    fixture.navy,
    "an enclosed dark screen must survive the border flood fill",
  );
  assert.deepEqual(
    pixel(result.data, fixture.width, 2, 4),
    fixture.blue,
    "the blue subject shell must remain opaque and color-faithful",
  );

  const removedPixels = fixture.width * fixture.height - visiblePixelCount(result.data);
  assert.ok(Math.abs(
    result.removedFraction - removedPixels / (fixture.width * fixture.height),
  ) < 1e-9);
});

test("one stray translucent pixel cannot disable background removal", () => {
  const fixture = mascotOnDarkNavyBackground();
  setPixel(fixture.data, fixture.width, 0, 0, [8, 8, 24, 249]);

  const result = prepareReferencePixels(fixture);

  assert.equal(result.backgroundRemoved, true);
  assert.deepEqual(result.bounds, { x: 2, y: 2, width: 7, height: 10 });
  assert.equal(pixel(result.data, fixture.width, 0, 0)[3], 0);
});

test("existing reference transparency stays byte-exact and produces tight visible bounds", () => {
  const width = 8;
  const height = 7;
  const data = solidRgba(width, height, [91, 17, 203, 0]);
  setPixel(data, width, 1, 1, [255, 0, 0, 5]);
  for (let y = 2; y <= 4; y += 1) {
    for (let x = 2; x <= 5; x += 1) {
      setPixel(data, width, x, y, [32 + x, 80 + y, 240, 255]);
    }
  }
  setPixel(data, width, 2, 2, [32, 82, 240, 128]);
  const before = new Uint8ClampedArray(data);

  const result = prepareReferencePixels({ data, width, height });

  assert.equal(result.backgroundRemoved, false);
  assert.equal(result.removedFraction, 0);
  assert.deepEqual(result.bounds, { x: 2, y: 2, width: 4, height: 3 });
  assert.deepEqual(result.data, before);
  assert.notEqual(result.data, data, "the returned pixels must not alias caller-owned input");
  assert.deepEqual(data, before, "preparation must preserve caller-owned transparent pixels");
});

test("reference preparation rejects malformed and fully transparent images", () => {
  assert.throws(
    () => prepareReferencePixels({
      data: new Uint8ClampedArray(15),
      width: 2,
      height: 2,
    }),
    /non-empty RGBA image/u,
  );
  assert.throws(
    () => prepareReferencePixels({
      data: solidRgba(4, 4, [0, 0, 0, 0]),
      width: 4,
      height: 4,
    }),
    /no visible pixels/u,
  );
});

test("initial reference placement is centered, bounded, and aspect locked", () => {
  const context = { x: 192, y: 220, width: 512, height: 512 };
  const aspectRatio = 264 / 350;
  const placement = initialReferencePlacementRegion(context, aspectRatio);

  assertAspectLocked(placement, aspectRatio);
  assert.ok(placement.width >= REFERENCE_PLACEMENT_MIN_EDGE);
  assert.ok(placement.height >= REFERENCE_PLACEMENT_MIN_EDGE);
  assert.ok(placement.width <= MAX_EDIT_EDGE);
  assert.ok(placement.height <= MAX_EDIT_EDGE);
  assert.ok(placement.x >= context.x);
  assert.ok(placement.y >= context.y);
  assert.ok(placement.x + placement.width <= context.x + context.width);
  assert.ok(placement.y + placement.height <= context.y + context.height);
  assert.equal(
    Math.max(placement.width, placement.height),
    Math.max(context.width, context.height),
    "the exact preview should fill the chosen patch instead of hiding at 35% scale",
  );
  assert.ok(
    Math.abs(
      placement.x + placement.width / 2 - (context.x + context.width / 2),
    ) <= 0.5,
  );
  assert.ok(
    Math.abs(
      placement.y + placement.height / 2 - (context.y + context.height / 2),
    ) <= 0.5,
  );
});

test("initial reference placement keeps accepted panoramic aspects server-valid", () => {
  const context = { x: 800, y: 832, width: 448, height: 384 };

  for (const [aspectRatio, expectedSize] of [
    [8, { width: 512, height: 64 }],
    [1 / 8, { width: 64, height: 512 }],
    [7.5, { width: 480, height: 64 }],
  ]) {
    const placement = initialReferencePlacementRegion(context, aspectRatio);

    assert.deepEqual(
      { width: placement.width, height: placement.height },
      expectedSize,
    );
    assertAspectLocked(placement, aspectRatio);
    assert.ok(placement.width >= REFERENCE_PLACEMENT_MIN_EDGE);
    assert.ok(placement.height >= REFERENCE_PLACEMENT_MIN_EDGE);
    assert.ok(placement.width <= MAX_EDIT_EDGE);
    assert.ok(placement.height <= MAX_EDIT_EDGE);
    assert.ok(placement.x >= 0);
    assert.ok(placement.y >= 0);
    assert.ok(placement.x + placement.width <= ARTWORK_SIZE);
    assert.ok(placement.y + placement.height <= ARTWORK_SIZE);
    assert.ok(
      Math.abs(
        placement.x + placement.width / 2 - (context.x + context.width / 2),
      ) <= 0.5,
    );
    assert.ok(
      Math.abs(
        placement.y + placement.height / 2 - (context.y + context.height / 2),
      ) <= 0.5,
    );
  }
});

test("initial panoramic placement clamps at canvas edges without changing size", () => {
  const cases = [
    {
      context: { x: 0, y: 0, width: 448, height: 384 },
      aspectRatio: 8,
      expected: { x: 0, y: 160, width: 512, height: 64 },
    },
    {
      context: {
        x: ARTWORK_SIZE - 448,
        y: ARTWORK_SIZE - 384,
        width: 448,
        height: 384,
      },
      aspectRatio: 1 / 8,
      expected: {
        x: ARTWORK_SIZE - 256,
        y: ARTWORK_SIZE - 512,
        width: 64,
        height: 512,
      },
    },
  ];

  for (const { context, aspectRatio, expected } of cases) {
    const placement = initialReferencePlacementRegion(context, aspectRatio);

    assert.deepEqual(placement, expected);
    assertAspectLocked(placement, aspectRatio);
    assert.ok(placement.width >= REFERENCE_PLACEMENT_MIN_EDGE);
    assert.ok(placement.height >= REFERENCE_PLACEMENT_MIN_EDGE);
    assert.ok(placement.x >= 0);
    assert.ok(placement.y >= 0);
    assert.ok(placement.x + placement.width <= ARTWORK_SIZE);
    assert.ok(placement.y + placement.height <= ARTWORK_SIZE);
  }
});

test("reference placement resize preserves origin and aspect at normal and edge bounds", () => {
  const aspectRatio = 264 / 350;
  const current = { x: 800, y: 700, width: 128, height: 170 };
  const resized = resizeReferencePlacementRegion(
    current,
    310,
    430,
    aspectRatio,
  );

  assert.deepEqual(
    { x: resized.x, y: resized.y },
    { x: current.x, y: current.y },
  );
  assertAspectLocked(resized, aspectRatio);
  assert.ok(resized.width >= REFERENCE_PLACEMENT_MIN_EDGE);
  assert.ok(resized.height >= REFERENCE_PLACEMENT_MIN_EDGE);
  assert.ok(resized.width <= MAX_EDIT_EDGE);
  assert.ok(resized.height <= MAX_EDIT_EDGE);

  const nearEdge = {
    x: ARTWORK_SIZE - 68,
    y: ARTWORK_SIZE - 148,
    width: 68,
    height: 90,
  };
  const edgeBounded = resizeReferencePlacementRegion(
    nearEdge,
    400,
    500,
    aspectRatio,
  );
  assert.deepEqual(
    { x: edgeBounded.x, y: edgeBounded.y },
    { x: nearEdge.x, y: nearEdge.y },
  );
  assert.ok(edgeBounded.x + edgeBounded.width <= ARTWORK_SIZE);
  assert.ok(edgeBounded.y + edgeBounded.height <= ARTWORK_SIZE);
  assertAspectLocked(edgeBounded, aspectRatio);
});

test("invalid reference aspects normalize to a square placement", () => {
  const context = { x: 200, y: 300, width: 400, height: 300 };
  const initial = initialReferencePlacementRegion(context, Number.NaN);
  const resized = resizeReferencePlacementRegion(
    initial,
    300,
    180,
    0,
  );

  assert.equal(initial.width, initial.height);
  assert.equal(resized.width, resized.height);
  assert.deepEqual(
    { x: resized.x, y: resized.y },
    { x: initial.x, y: initial.y },
  );
});
