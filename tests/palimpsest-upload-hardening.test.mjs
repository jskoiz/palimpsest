import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import test from "node:test";
import {
  moderatePlacement,
  PLACEMENT_MODERATION_MODEL,
  PLACEMENT_MODERATION_TIMEOUT_MS,
} from "../lib/palimpsest/moderation.mjs";
import {
  MAX_PLACEMENT_PNG_BYTES,
  PLACEMENT_PNG_HEIGHT,
  PLACEMENT_PNG_WIDTH,
  validatePlacementPng,
} from "../lib/palimpsest/png.mjs";

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0
      ? 0xedb88320 ^ (value >>> 1)
      : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function concatBytes(...parts) {
  const joined = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function pngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const body = concatBytes(typeBytes, data);
  return concatBytes(uint32(data.byteLength), body, uint32(crc32(body)));
}

function placementPng({
  colorType = 6,
  opaque = false,
  fullyTransparent = false,
  compressedOverride = null,
} = {}) {
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = PLACEMENT_PNG_WIDTH * bytesPerPixel;
  const scanlines = new Uint8Array(
    PLACEMENT_PNG_HEIGHT * (rowBytes + 1),
  );
  if (opaque && colorType === 6) {
    for (let row = 0; row < PLACEMENT_PNG_HEIGHT; row += 1) {
      const start = row * (rowBytes + 1) + 1;
      for (let alpha = start + 3; alpha < start + rowBytes; alpha += 4) {
        scanlines[alpha] = 255;
      }
    }
  } else if (!fullyTransparent && colorType === 6) {
    scanlines[4] = 255;
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, PLACEMENT_PNG_WIDTH);
  view.setUint32(4, PLACEMENT_PNG_HEIGHT);
  header[8] = 8;
  header[9] = colorType;
  const compressed =
    compressedOverride ?? new Uint8Array(deflateSync(scanlines));
  return concatBytes(
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  );
}

function chunkOffset(bytes, expectedType) {
  let offset = PNG_SIGNATURE.byteLength;
  while (offset + 12 <= bytes.byteLength) {
    const length = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset,
      4,
    ).getUint32(0);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (type === expectedType) return { offset, length };
    offset += 12 + length;
  }
  throw new Error(`Missing ${expectedType} chunk`);
}

function rejectedWith(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

test("placement PNG validation accepts only the exact transparent RGBA frame", async () => {
  const valid = placementPng();
  assert.ok(valid.byteLength < MAX_PLACEMENT_PNG_BYTES);
  assert.deepEqual(await validatePlacementPng(valid), {
    width: 1024,
    height: 1024,
    bitDepth: 8,
    colorType: 6,
  });
});

test("placement PNG validation rejects malformed and truncated payloads", async () => {
  await assert.rejects(
    validatePlacementPng(Uint8Array.of(137, 80, 78, 71)),
    rejectedWith("INVALID_REQUEST"),
  );
  const valid = placementPng();
  await assert.rejects(
    validatePlacementPng(valid.slice(0, -3)),
    rejectedWith("INVALID_REQUEST"),
  );
});

test("placement PNG validation rejects a wrong color model", async () => {
  await assert.rejects(
    validatePlacementPng(placementPng({ colorType: 2 })),
    rejectedWith("INVALID_REQUEST"),
  );
});

test("placement PNG validation rejects a bad chunk CRC", async () => {
  const corrupted = placementPng().slice();
  const idat = chunkOffset(corrupted, "IDAT");
  const crcOffset = idat.offset + 8 + idat.length;
  corrupted[crcOffset + 3] ^= 0xff;
  await assert.rejects(
    validatePlacementPng(corrupted),
    rejectedWith("INVALID_REQUEST"),
  );
});

test("placement PNG validation rejects invalid deflate data", async () => {
  await assert.rejects(
    validatePlacementPng(
      placementPng({
        compressedOverride: Uint8Array.of(0x78, 0x9c, 0xff, 0xff),
      }),
    ),
    rejectedWith("INVALID_REQUEST"),
  );
});

test("placement PNG validation rejects opaque RGBA frames", async () => {
  await assert.rejects(
    validatePlacementPng(placementPng({ opaque: true })),
    rejectedWith("INVALID_REQUEST"),
  );
});

test("placement PNG validation rejects fully transparent no-op frames", async () => {
  await assert.rejects(
    validatePlacementPng(placementPng({ fullyTransparent: true })),
    rejectedWith("INVALID_REQUEST"),
  );
});

test("placement moderation sends the exact prompt and PNG in one bounded request", async () => {
  const pngBytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  let captured;
  const result = await moderatePlacement({
    apiKey: "test-key",
    prompt: "place the mascot",
    pngBytes,
    fetcher: async (url, init) => {
      captured = { url, init };
      return Response.json(
        { results: [{ flagged: false }] },
        { headers: { "x-request-id": "moderation-request" } },
      );
    },
  });
  assert.deepEqual(result, { requestId: "moderation-request" });
  assert.equal(PLACEMENT_MODERATION_MODEL, "omni-moderation-latest");
  assert.equal(PLACEMENT_MODERATION_TIMEOUT_MS, 10_000);
  assert.equal(captured.url, "https://api.openai.com/v1/moderations");
  assert.equal(captured.init.method, "POST");
  assert.ok(captured.init.signal instanceof AbortSignal);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, PLACEMENT_MODERATION_MODEL);
  assert.deepEqual(body.input[0], {
    type: "text",
    text: "place the mascot",
  });
  assert.equal(body.input[1].type, "image_url");
  assert.match(body.input[1].image_url.url, /^data:image\/png;base64,/u);
});

test("flagged placement moderation fails closed with content policy", async () => {
  await assert.rejects(
    moderatePlacement({
      apiKey: "test-key",
      prompt: "flag this",
      pngBytes: Uint8Array.of(1, 2, 3),
      fetcher: async () => Response.json({ results: [{ flagged: true }] }),
    }),
    rejectedWith("CONTENT_POLICY"),
  );
});

test("unavailable or malformed placement moderation never defaults to allow", async (t) => {
  const cases = [
    {
      name: "missing API key",
      apiKey: "",
      fetcher: async () => {
        throw new Error("must not fetch");
      },
    },
    {
      name: "provider rejection",
      apiKey: "test-key",
      fetcher: async () =>
        Response.json({ error: { message: "unavailable" } }, { status: 503 }),
    },
    {
      name: "malformed provider response",
      apiKey: "test-key",
      fetcher: async () => Response.json({ results: [] }),
    },
    {
      name: "network failure",
      apiKey: "test-key",
      fetcher: async () => {
        throw new Error("offline");
      },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await assert.rejects(
        moderatePlacement({
          apiKey: scenario.apiKey,
          prompt: "place the mascot",
          pngBytes: Uint8Array.of(1, 2, 3),
          fetcher: scenario.fetcher,
        }),
        rejectedWith("PROVIDER_TEMPORARY"),
      );
    });
  }
});
