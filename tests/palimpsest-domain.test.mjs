import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ARTWORK_SIZE,
  DomainError,
  assertFreshBase,
  buildOpenAiEditPrompt,
  createDisplayMaskSvg,
  displayMaskForLayer,
  referenceImagePlacement,
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
  positionEditRegionAvoidingRegions,
  regionRelativeToFrame,
  resizeEditRegion,
  resizeEditRegionAvoidingRegions,
  regionsOverlap,
  timelineIndexAtPosition,
} from "../lib/palimpsest/geometry.mjs";
import {
  EDIT_PLANNER_MODEL,
  buildContainmentReviewRequest,
  buildEditPlanRequest,
  extractContainmentReview,
  extractEditPlan,
} from "../lib/palimpsest/ai-planner.mjs";

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

  assert.deepEqual(
    validateRegion({
      region: { x: 0, y: 0, width: 512, height: 512 },
      fill: true,
    }).region,
    { x: 0, y: 0, width: 512, height: 512 },
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

test("display masks keep exact hard edit boundaries without feathering", () => {
  const region = { x: 100, y: 200, width: 384, height: 320 };
  const svg = createDisplayMaskSvg({ region, fill: true, strokes: [] });
  assert.doesNotMatch(svg, /feGaussianBlur|filter=/);
  assert.match(svg, /clipPath id="edit-bounds"/);
  assert.match(svg, /<rect x="100" y="200" width="384" height="320" fill="white"/);
});

test("reference framing preserves the full image with a safety margin", () => {
  assert.deepEqual(referenceImagePlacement(768, 574, { width: 384, height: 320 }), {
    x: 397,
    y: 426,
    width: 230,
    height: 172,
  });
  assert.deepEqual(referenceImagePlacement(574, 768, { width: 384, height: 320 }), {
    x: 440,
    y: 416,
    width: 144,
    height: 192,
  });
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

test("new archives begin with one purple abstract revision", async () => {
  const [storeSource, domainSource] = await Promise.all([
    readFile(new URL("../lib/palimpsest/store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/palimpsest/domain.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(domainSource, /ARTWORK_ID = "palimpsest-purple"/);
  assert.match(storeSource, /prompt: "Purple abstract canvas\."/);
  assert.match(storeSource, /rev-seed-purple-000/);
  assert.match(storeSource, /blob-purple-base-/);
  assert.match(storeSource, /seedRevisions\[0\]\.id, createdAt/);
  assert.match(storeSource, /2, 2, \?, 0, \?\)/);
  assert.doesNotMatch(storeSource, /rev-seed-00[1-9]|blob-seed-patch/);
  assert.match(storeSource, /\?sha256=\$\{encodeURIComponent\(tile\.sha256\)\}/);
});

test("canonical seed assets are the verified purple abstract canvas", async () => {
  const assets = [
    [
      "../public/seed/canonical.png",
      2048,
      "12a2ef4ba08d5eda39c16816fe40c3f50846643b45982b8882566d9182afc27c",
    ],
    [
      "../public/seed/tile-0-0.png",
      1024,
      "b9b641ffde035c2fd48e7edf8687dc24a4f861a58ff6e3ec8cdb8b16fa5e0723",
    ],
    [
      "../public/seed/tile-1-0.png",
      1024,
      "bc51ce00a4fec4c271d7ed5b27d0edbd3fa1a75bc525183c5c1ee48a10ed6539",
    ],
    [
      "../public/seed/tile-0-1.png",
      1024,
      "801672e584e3ecb6ec942c88a72e8b9169d582eda919bddb5feef20e94187b59",
    ],
    [
      "../public/seed/tile-1-1.png",
      1024,
      "265f67b0f802cd643ad50942a72e79fb35dbd21c091b982e2ac8f3a3c58e9f24",
    ],
  ];

  for (const [relativePath, size, expectedHash] of assets) {
    const bytes = await readFile(new URL(relativePath, import.meta.url));
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash);
  }
});

test("new contributions expose only the live AI generation path", async () => {
  const [routeSource, clientSource, queueSource, storeSource, readme] =
    await Promise.all([
      readFile(new URL("../app/api/edits/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/Palimpsest.tsx", import.meta.url), "utf8"),
      readFile(new URL("../lib/palimpsest/queue.ts", import.meta.url), "utf8"),
      readFile(new URL("../lib/palimpsest/store.ts", import.meta.url), "utf8"),
      readFile(new URL("../README.md", import.meta.url), "utf8"),
    ]);

  assert.match(routeSource, /Generation mode is server-controlled/);
  assert.match(routeSource, /OPENAI_API_KEY\?\.trim\(\)/);
  assert.doesNotMatch(routeSource, /Deterministic demo|executionMode ===/);
  assert.doesNotMatch(clientSource, /setExecutionMode|\[x\] live ai edit/);
  assert.match(clientSource, /disabled=\{jobActive \|\| !liveEditingAvailable\}/);
  assert.match(clientSource, /"generate live →"/);
  assert.doesNotMatch(queueSource, /makeDemoPatchSvg|image\/svg\+xml/);
  assert.match(storeSource, /"openai",\s*authorId/);
  assert.match(storeSource, /available: Boolean\(env\.OPENAI_API_KEY\?\.trim\(\)\)/);
  assert.doesNotMatch(readme, /demo renderer/i);
});

test("live image prompts keep random objects whole without forcing an art style", () => {
  const prompt = buildOpenAiEditPrompt("Add a bright plastic toy truck.");
  assert.match(prompt, /entire subject comfortably inside the editable area/i);
  assert.match(prompt, /Never crop, truncate/i);
  assert.match(prompt, /clear margin on every side/i);
  assert.match(prompt, /reference subject touches an edge/i);
  assert.match(prompt, /without forcing it into a predefined artistic motif/i);
  assert.match(prompt, /Add a bright plastic toy truck\./);
  assert.doesNotMatch(prompt, /vermilion|graphite|mixed-media/i);
});

test("reference-image prompts use the second input without pasting its frame", () => {
  const prompt = buildOpenAiEditPrompt("Add the flower from my reference.", true);
  assert.match(prompt, /second supplied image as a direct visual reference/i);
  assert.match(prompt, /already been centered and scaled/i);
  assert.match(prompt, /do not enlarge it/i);
  assert.match(prompt, /do not paste its rectangular background/i);
  assert.match(prompt, /isolated transparent PNG layer/i);
  assert.match(prompt, /every non-subject pixel fully transparent/i);
  assert.match(prompt, /Do not redraw the source canvas/i);
  assert.match(prompt, /Add the flower from my reference\./);
});

test("GPT-5.6 plans the requested edit without changing contributor intent", () => {
  const request = buildEditPlanRequest("Add one cobalt paper boat.", true);

  assert.equal(request.model, EDIT_PLANNER_MODEL);
  assert.equal(request.model, "gpt-5.6");
  assert.deepEqual(request.reasoning, { effort: "low" });
  assert.equal(request.store, false);
  assert.match(request.instructions, /Preserve the contributor's intent/i);
  assert.match(request.instructions, /Do not invent new subjects/i);
  assert.match(request.input, /Add one cobalt paper boat\./);
  assert.match(request.input, /second image/i);
});

test("GPT-5.6 edit plans are read from message output rather than reasoning items", () => {
  const plan = extractEditPlan({
    output: [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        content: [
          { type: "refusal", refusal: "not used" },
          { type: "output_text", text: "Add one cobalt paper boat." },
        ],
      },
      {
        type: "message",
        content: [
          { type: "output_text", text: "Keep it fully inside the masked area." },
        ],
      },
    ],
  });

  assert.equal(
    plan,
    "Add one cobalt paper boat.\nKeep it fully inside the masked area.",
  );
  assert.equal(extractEditPlan({ output: [{ type: "reasoning" }] }), null);
});

test("reference generations receive structured whole-subject containment review", () => {
  const request = buildContainmentReviewRequest({
    requestedChange: "Place the mini keyboard.",
    generatedImageUrl: "data:image/png;base64,generated",
    providerMaskUrl: "data:image/png;base64,mask",
  });
  assert.equal(request.model, "gpt-5.6");
  assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 500);
  assert.equal(request.input[0].content[1].type, "input_image");
  assert.equal(request.input[0].content[2].image_url, "data:image/png;base64,mask");
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);
  assert.match(request.input[0].content[0].text, /clear space on every side/i);
  assert.match(request.input[0].content[0].text, /all background outside the subject is transparent/i);
  assert.deepEqual(request.text.format.schema.required, [
    "contained",
    "backgroundClear",
    "reason",
  ]);

  assert.deepEqual(
    extractContainmentReview({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: '{"contained":false,"backgroundClear":true,"reason":"The keyboard is cut off."}',
        }],
      }],
    }),
    { contained: false, backgroundClear: true, reason: "The keyboard is cut off." },
  );
  assert.equal(extractContainmentReview({ output: [] }), null);
});

test("reference images stay optional, visible in the patch, and reach live generation", async () => {
  const [routeSource, clientSource, queueSource, storeSource] = await Promise.all([
    readFile(new URL("../app/api/edits/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/Palimpsest.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/palimpsest/queue.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/palimpsest/store.ts", import.meta.url), "utf8"),
  ]);

  assert.match(clientSource, /form\.append\("reference", referenceImage\.blob/);
  assert.match(clientSource, /mono-reference-on-canvas/);
  assert.match(clientSource, /image\/png,image\/jpeg,image\/webp/);
  assert.match(routeSource, /referenceValue instanceof File/);
  assert.match(routeSource, /referenceBytes/);
  assert.match(storeSource, /reference_blob_id/);
  assert.doesNotMatch(storeSource, /kind[^\n]*'reference'|VALUES \([^\n]*'reference'/);
  assert.match(storeSource, /referenceBlobId,[\s\S]*VALUES \(\?, \?, 'input'/);
  assert.match(queueSource, /palimpsest-reference\.png/);
  assert.match(queueSource, /imageEditProviderPolicy\(Boolean\(referenceBytes\)\)/);
  assert.match(queueSource, /form\.append\("background", imagePolicy\.background\)/);
  assert.match(queueSource, /form\.append\("input_fidelity", imagePolicy\.inputFidelity\)/);
  assert.match(queueSource, /buildOpenAiEditPrompt\(plannedPrompt, Boolean\(reference\)\)/);
  assert.match(queueSource, /reviewPatchContainment/);
  assert.match(queueSource, /MAX_CONTAINMENT_ATTEMPTS = 2/);
  assert.match(queueSource, /no more than 45%/);
  assert.match(queueSource, /https:\/\/api\.openai\.com\/v1\/responses/);
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

test("patch resizing stays useful, bounded, and inside the artwork", () => {
  const region = { x: 800, y: 800, width: 448, height: 384 };

  assert.deepEqual(resizeEditRegion(region, 496, 432), {
    x: 800,
    y: 800,
    width: 496,
    height: 432,
  });
  assert.deepEqual(resizeEditRegion(region, 40, 900), {
    x: 800,
    y: 800,
    width: 160,
    height: 512,
  });
  assert.deepEqual(
    resizeEditRegion({ x: 1960, y: 1930, width: 88, height: 118 }, 500, 500, 64),
    { x: 1960, y: 1930, width: 88, height: 118 },
  );
});

test("patch resizing cannot enter a live reservation", () => {
  const patch = { x: 100, y: 100, width: 200, height: 200 };
  const reserved = [{ x: 360, y: 100, width: 120, height: 180 }];

  assert.deepEqual(
    resizeEditRegionAvoidingRegions(patch, 400, 260, reserved),
    { x: 100, y: 100, width: 200, height: 260 },
  );
  assert.deepEqual(
    resizeEditRegionAvoidingRegions(patch, 400, 400, [
      ...reserved,
      { x: 100, y: 320, width: 180, height: 120 },
    ]),
    patch,
  );
});

test("patch placement stops at live reservation edges without blocking edge contact", () => {
  const patch = { x: 100, y: 100, width: 100, height: 100 };
  const reserved = [{ x: 300, y: 100, width: 100, height: 100 }];

  assert.deepEqual(positionEditRegionAvoidingRegions(patch, 200, 100, reserved), {
    x: 200,
    y: 100,
    width: 100,
    height: 100,
  });
  assert.deepEqual(positionEditRegionAvoidingRegions(patch, 250, 100, reserved), {
    x: 200,
    y: 100,
    width: 100,
    height: 100,
  });

  assert.deepEqual(positionEditRegionAvoidingRegions(
    { x: 200, y: 100, width: 100, height: 100 },
    450,
    100,
    reserved,
  ), {
    x: 200,
    y: 100,
    width: 100,
    height: 100,
  });
});

test("patch placement cannot tunnel through adjacent live reservations", () => {
  const patch = { x: 100, y: 100, width: 100, height: 100 };
  const reserved = [
    { x: 300, y: 100, width: 100, height: 100 },
    { x: 200, y: 100, width: 100, height: 100 },
  ];
  const placed = positionEditRegionAvoidingRegions(patch, 250, 100, reserved);

  assert.equal(reserved.some((region) => regionsOverlap(placed, region)), false);
  assert.deepEqual(placed, { x: 100, y: 100, width: 100, height: 100 });
});

test("patch placement slides along a live reservation without entering it", () => {
  const patch = { x: 100, y: 100, width: 100, height: 100 };
  const reserved = [{ x: 300, y: 100, width: 100, height: 100 }];
  const placed = positionEditRegionAvoidingRegions(patch, 350, 250, reserved);

  assert.equal(reserved.some((region) => regionsOverlap(placed, region)), false);
  assert.deepEqual(placed, { x: 200, y: 250, width: 100, height: 100 });
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
