import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { inspectPngAlphaPlacement } from "../lib/palimpsest/png-alpha.mjs";

function pngChunk(type, data) {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, 4, "ascii");
  data.copy(bytes, 8);
  return bytes;
}

function rgbaPng(width, height, alphaAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      scanlines[offset] = 240;
      scanlines[offset + 1] = 240;
      scanlines[offset + 2] = 240;
      scanlines[offset + 3] = alphaAt(x, y);
    }
  }

  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

const region = { x: 2, y: 2, width: 12, height: 12 };

test("isolated alpha with clear space passes without feathering the patch", async () => {
  const png = rgbaPng(16, 16, (x, y) =>
    (y >= 5 && y <= 10 && x >= 5 && x <= 10 && (x + y) % 3 !== 0 ? 255 : 0));
  const result = await inspectPngAlphaPlacement(png, region, { marginPixels: 1 });

  assert.equal(result.backgroundClear, true);
  assert.equal(result.touchesBoundary, false);
  assert.deepEqual(result.bounds, { x: 5, y: 5, width: 6, height: 6 });
});

test("visible alpha touching an editable edge is rejected", async () => {
  const png = rgbaPng(16, 16, (x, y) =>
    (x >= 2 && x <= 7 && y >= 5 && y <= 10 ? 255 : 0));
  const result = await inspectPngAlphaPlacement(png, region, { marginPixels: 1 });

  assert.equal(result.backgroundClear, false);
  assert.equal(result.touchesBoundary, true);
});

test("an opaque rectangular matte is rejected even when inset", async () => {
  const png = rgbaPng(16, 16, (x, y) =>
    (x >= 5 && x <= 10 && y >= 5 && y <= 10 ? 255 : 0));
  const result = await inspectPngAlphaPlacement(png, region, { marginPixels: 1 });

  assert.equal(result.backgroundClear, false);
  assert.equal(result.rectangularFill, true);
});

test("an empty or unsupported PNG fails closed", async () => {
  const empty = await inspectPngAlphaPlacement(
    rgbaPng(16, 16, () => 0),
    region,
    { marginPixels: 1 },
  );
  assert.equal(empty.backgroundClear, false);
  assert.equal(empty.bounds, null);

  await assert.rejects(
    inspectPngAlphaPlacement(new Uint8Array([1, 2, 3]), region),
    /valid PNG/i,
  );
});

test("the queue uses pixel alpha for background clearance and vision for containment", async () => {
  const queueSource = await readFile(
    new URL("../lib/palimpsest/queue.ts", import.meta.url),
    "utf8",
  );

  assert.match(queueSource, /inspectPngAlphaPlacement\(patch\.bytes, localRegion\)/);
  assert.match(queueSource, /review\.contained && alphaReview\.backgroundClear/);
  assert.doesNotMatch(queueSource, /review\.contained && review\.backgroundClear/);
});
