import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ARTWORK_SIZE,
  DomainError,
  REFERENCE_EDIT_MIN_EDGE,
  REFERENCE_TARGET_FILL,
  assertFreshBase,
  assertReferenceEditRegion,
  buildOpenAiEditPrompt,
  createDisplayMaskSvg,
  displayMaskForLayer,
  referencePlacementRegion,
  resolveLayerStack,
  serializeHistory,
  validateRegion,
} from "../lib/palimpsest/domain.mjs";
import {
  canvasPanBounds,
  canvasViewCanPan,
  constrainCanvasView,
  generationFrameForRegion,
  maskInGenerationFrame,
  nudgeEditRegion,
  positionEditRegion,
  referenceSafeEditRegion,
  regionInGenerationFrame,
  resizeEditRegion,
  regionsOverlap,
  timelineIndexAtPosition,
} from "../lib/palimpsest/geometry.mjs";
import {
  EDIT_REVIEW_MODEL,
  buildEditOutputReviewRequest,
  extractEditOutputReview,
  buildReferenceEditReviewRequest,
  extractReferenceEditReview,
  referenceReviewOutcome,
} from "../lib/palimpsest/ai-review.mjs";
import {
  activityJobCounts,
  activityJobState,
  collaborationPollDelay,
  publicActivityJobs,
  queueRecoveryDelay,
  viewForActivityRegion,
} from "../app/activity-ui.mjs";
import {
  EDIT_REVIEW_TIMEOUT_MS,
  IMAGE_EDIT_TIMEOUT_MS,
  WORKER_HEARTBEAT_MS,
  WORKER_LEASE_MS,
  WORKER_TOTAL_BUDGET_MS,
  boundedStageTimeout,
} from "../lib/palimpsest/worker-policy.mjs";

function expectCode(callback, code) {
  assert.throws(callback, (error) => error instanceof DomainError && error.code === code);
}

test("activity jobs use stable visitor-facing states and separate failures from in-process work", () => {
  const jobs = [
    { state: "queued", reservationActive: true },
    { state: "moderating", reservationActive: true },
    { state: "generating", reservationActive: true },
    { state: "committing", reservationActive: true },
    { state: "generating", reservationActive: false },
    { state: "failed", reservationActive: false },
    { state: "succeeded", reservationActive: false },
  ];

  assert.deepEqual(jobs.map(activityJobState), [
    "reserved",
    "starting",
    "generating",
    "finishing",
    "recovering",
    "failed",
    "done",
  ]);
  assert.deepEqual(activityJobCounts(jobs), { inProcess: 5, failed: 1, done: 1 });
  assert.deepEqual(publicActivityJobs(jobs), jobs.slice(0, 5));
});

test("queue recovery and collaboration polling back off with bounded jitter", () => {
  assert.equal(queueRecoveryDelay(0, 0.5), 2_000);
  assert.equal(queueRecoveryDelay(1, 0.5), 4_000);
  assert.equal(queueRecoveryDelay(8, 0.5), 15_000);
  assert.equal(queueRecoveryDelay(0, 0), 1_700);
  assert.equal(queueRecoveryDelay(0, 1), 2_300);

  assert.equal(collaborationPollDelay(true, false, 0.5), 3_000);
  assert.equal(collaborationPollDelay(false, false, 0.5), 15_000);
  assert.equal(collaborationPollDelay(true, true, 0.5), 8_000);
  assert.equal(collaborationPollDelay(false, true, 0.5), 30_000);
});

test("worker timing stays bounded and renews well before expiry", () => {
  assert.equal(WORKER_LEASE_MS, 60_000);
  assert.equal(WORKER_HEARTBEAT_MS, 15_000);
  assert.ok(WORKER_HEARTBEAT_MS * 3 < WORKER_LEASE_MS);
  assert.equal(IMAGE_EDIT_TIMEOUT_MS, 120_000);
  assert.equal(EDIT_REVIEW_TIMEOUT_MS, 45_000);
  assert.equal(WORKER_TOTAL_BUDGET_MS, 180_000);
  assert.ok(IMAGE_EDIT_TIMEOUT_MS + EDIT_REVIEW_TIMEOUT_MS < WORKER_TOTAL_BUDGET_MS);
  assert.equal(boundedStageTimeout(10_000, 45_000, 1_000), 9_000);
  assert.equal(boundedStageTimeout(10_000, 45_000, 12_000), 0);
});

test("activity region focus places the target above the queue panel", () => {
  const region = { x: 0, y: 0, width: 200, height: 200 };
  const view = viewForActivityRegion(region, 1000, 600, ARTWORK_SIZE);
  const canvasSize = 1000;
  const coverTop = (600 - canvasSize) / 2;
  const centerX = ((region.x + region.width / 2) / ARTWORK_SIZE) * canvasSize;
  const centerY = coverTop + ((region.y + region.height / 2) / ARTWORK_SIZE) * canvasSize;

  assert.equal(view.zoom, 1.65);
  assert.ok(Math.abs(view.x + view.zoom * centerX - 500) < 0.001);
  assert.ok(Math.abs(view.y + view.zoom * centerY - 600 * 0.38) < 0.001);
});

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

test("filled display masks feather their edges while painted masks stay exact", () => {
  const region = { x: 100, y: 200, width: 384, height: 320 };
  const filledSvg = createDisplayMaskSvg({ region, fill: true, strokes: [] });
  assert.match(filledSvg, /feGaussianBlur stdDeviation="16"/);
  assert.match(filledSvg, /clipPath id="edit-bounds"/);
  assert.match(filledSvg, /<rect x="132" y="232" width="320" height="256" fill="white"/);

  const paintedSvg = createDisplayMaskSvg({
    region,
    fill: false,
    strokes: [{ width: 16, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }],
  });
  assert.doesNotMatch(paintedSvg, /feGaussianBlur|filter=/);
  assert.match(paintedSvg, /<polyline points="110,220 130,240"/);
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
  assert.match(prompt, /approaches the editable edge/i);
  assert.match(prompt, /without forcing it into a predefined artistic motif/i);
  assert.match(prompt, /Add a bright plastic toy truck\./);
  assert.doesNotMatch(prompt, /vermilion|graphite|mixed-media/i);
});

test("reference-image prompts preserve the positioned subject while blending its frame", () => {
  const prompt = buildOpenAiEditPrompt("Add the flower from my reference.", true);
  assert.match(prompt, /Image 1 is a high-resolution working crop/i);
  assert.match(prompt, /Image 2 is the contributor's full-resolution visual reference/i);
  assert.match(prompt, /transparent mask area is the exact placement footprint/i);
  assert.match(prompt, /identity and detail source/i);
  assert.match(prompt, /do not enlarge, crop, reposition, redesign/i);
  assert.match(prompt, /control count and arrangement, symbols, labels/i);
  assert.match(prompt, /matching local perspective, scale, lighting/i);
  assert.match(prompt, /Do not copy the reference image's rectangular background/i);
  assert.match(prompt, /Preserve every existing Image 1 pixel/i);
  assert.match(prompt, /including existing text and marks/i);
  assert.match(prompt, /do not invent hidden structure or replacement controls/i);
  assert.match(prompt, /Reference backgrounds, display stands, or secondary props may be omitted/i);
  assert.match(prompt, /surrounding opaque mask is protected prior artwork/i);
  assert.match(prompt, /Add the flower from my reference\./);
});

test("reference placement prompt is strict enough for one bounded image pass", () => {
  const prompt = buildOpenAiEditPrompt("Add the flower from my reference.", true);
  assert.match(prompt, /Match the reference preview's scale and center exactly/i);
  assert.match(prompt, /without shrinking it below half/i);
  assert.doesNotMatch(prompt, /retry/i);
});

test("every generated subject receives a structured framing review", () => {
  const request = buildEditOutputReviewRequest({
    requestedChange: "handwritten note that says 'Codex is awesome'",
    generatedImageUrl: "data:image/png;base64,generated",
    providerMaskUrl: "data:image/png;base64,mask",
    editableRegion: { x: 0, y: 382, width: 326, height: 260 },
  });

  assert.equal(request.model, EDIT_REVIEW_MODEL);
  assert.equal(request.model, "gpt-5.6");
  assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 500);
  assert.equal(request.input[0].content[1].image_url, "data:image/png;base64,generated");
  assert.equal(request.input[0].content[2].image_url, "data:image/png;base64,mask");
  assert.match(request.instructions, /handwriting, printed text/i);
  assert.match(request.instructions, /every requested word, letter/i);
  assert.match(request.instructions, /touching, crossing, or appearing truncated/i);
  assert.match(request.input[0].content[0].text, /right edge is x=326/i);
  assert.match(request.input[0].content[0].text, /bottom edge is y=642/i);
  assert.deepEqual(request.text.format.schema.required, [
    "contained",
    "blended",
    "reason",
  ]);

  assert.deepEqual(
    extractEditOutputReview({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: '{"contained":false,"blended":true,"reason":"The word ends at the right boundary."}',
        }],
      }],
    }),
    {
      contained: false,
      blended: true,
      reason: "The word ends at the right boundary.",
    },
  );
  assert.equal(extractEditOutputReview({ output: [] }), null);
});

test("reference generations receive structured fidelity and blending review", () => {
  const request = buildReferenceEditReviewRequest({
    requestedChange: "Place the mini keyboard.",
    generatedImageUrl: "data:image/png;base64,generated",
    sourceImageUrl: "data:image/png;base64,source",
    referenceImageUrl: "data:image/png;base64,reference",
    providerMaskUrl: "data:image/png;base64,mask",
    editableRegion: { x: 120, y: 220, width: 320, height: 400 },
  });
  assert.equal(request.model, EDIT_REVIEW_MODEL);
  assert.equal(request.model, "gpt-5.6");
  assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 500);
  assert.equal(request.input[0].content[1].type, "input_image");
  assert.equal(request.input[0].content[1].image_url, "data:image/png;base64,generated");
  assert.equal(request.input[0].content[2].image_url, "data:image/png;base64,source");
  assert.equal(request.input[0].content[3].image_url, "data:image/png;base64,reference");
  assert.equal(request.input[0].content[4].image_url, "data:image/png;base64,mask");
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);
  assert.match(request.instructions, /control count and arrangement, symbols, labels/i);
  assert.match(request.instructions, /no visible rectangular patch/i);
  assert.match(request.instructions, /smudging of uncovered prior artwork fails source preservation/i);
  assert.match(request.input[0].content[0].text, /visually faithful/i);
  assert.match(request.input[0].content[0].text, /matched to the preview's placement and relative scale/i);
  assert.match(request.input[0].content[0].text, /naturally blended/i);
  assert.match(
    request.input[0].content[0].text,
    /x=120, y=220, width=320, height=400; its right edge is x=440 and bottom edge is y=620/i,
  );
  assert.deepEqual(request.text.format.schema.required, [
    "contained",
    "faithful",
    "placementMatched",
    "blended",
    "sourcePreserved",
    "reason",
  ]);

  assert.deepEqual(
    extractReferenceEditReview({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: '{"contained":true,"faithful":false,"placementMatched":true,"blended":true,"sourcePreserved":true,"reason":"The controls were redesigned."}',
        }],
      }],
    }),
    {
      contained: true,
      faithful: false,
      placementMatched: true,
      blended: true,
      sourcePreserved: true,
      reason: "The controls were redesigned.",
    },
  );
  assert.equal(extractReferenceEditReview({ output: [] }), null);
});

test("reference review returns one terminal outcome without another image pass", () => {
  assert.equal(
    referenceReviewOutcome({
      contained: true,
      faithful: true,
      placementMatched: true,
      blended: true,
      sourcePreserved: true,
    }),
    "accept",
  );
  assert.equal(
    referenceReviewOutcome({
      contained: false,
      faithful: true,
      placementMatched: false,
      blended: true,
      sourcePreserved: true,
    }),
    "reject-containment",
  );
  assert.equal(
    referenceReviewOutcome({
      contained: true,
      faithful: false,
      placementMatched: true,
      blended: true,
      sourcePreserved: true,
    }),
    "reject-reference",
  );
  assert.equal(
    referenceReviewOutcome({
      contained: true,
      faithful: true,
      placementMatched: true,
      blended: false,
      sourcePreserved: true,
    }),
    "reject-reference",
  );
  assert.equal(
    referenceReviewOutcome({
      contained: true,
      faithful: true,
      placementMatched: true,
      blended: true,
      sourcePreserved: false,
    }),
    "reject-reference",
  );
});

test("live generation uses one bounded image pass and one review pass", async () => {
  const [routeSource, clientSource, queueSource, storeSource] = await Promise.all([
    readFile(new URL("../app/api/edits/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/Palimpsest.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/palimpsest/queue.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/palimpsest/store.ts", import.meta.url), "utf8"),
  ]);

  assert.match(clientSource, /form\.append\("reference", referenceImage\.blob/);
  assert.match(clientSource, /mono-reference-on-canvas/);
  assert.match(clientSource, /image\/png,image\/jpeg,image\/webp/);
  assert.match(clientSource, /makes one masked image pass/);
  assert.doesNotMatch(clientSource, /automatic retry/);
  assert.doesNotMatch(clientSource, /plans the request/);
  assert.doesNotMatch(clientSource, /REFERENCE_MASK_INSET/);
  assert.match(clientSource, /const normalized = await normalizeReferenceImage\(file\)/);
  assert.match(clientSource, /referenceSafeEditRegion/);
  assert.match(clientSource, /REFERENCE_EDIT_MIN_EDGE/);
  assert.match(clientSource, /drag the outer patch to position the exact preview/);
  assert.match(clientSource, /sourceBlob: file/);
  assert.match(clientSource, /REFERENCE_IMAGE_SIZE \/ image\.width/);
  assert.match(clientSource, /flattenArtworkFrame\(editBase\.state, frame\)/);
  assert.doesNotMatch(clientSource, /placeReferenceGuide/);
  assert.match(clientSource, /referencePlacementRegion\(generationMask\.region\)/);
  assert.match(clientSource, /Boolean\(referenceImage\)/);
  assert.match(clientSource, /maskInGenerationFrame/);
  assert.match(clientSource, /GENERATION_FRAME_SIZE/);
  assert.doesNotMatch(clientSource, /transparentGenerationFrame/);
  assert.doesNotMatch(clientSource, /normalizeReferenceImage\(file, editRegion\)/);
  assert.doesNotMatch(clientSource, /referenceImage \? REFERENCE_MASK_INSET : 0/);
  assert.match(routeSource, /referenceValue instanceof File/);
  assert.match(routeSource, /assertReferenceEditRegion\(validated\.region\)/);
  assert.match(routeSource, /referenceBytes/);
  assert.match(storeSource, /reference_blob_id/);
  assert.match(storeSource, /referencePlacementRegion\(generationMask\.region\)/);
  assert.match(storeSource, /generation: input\.referenceBytes \? "reference-placement" : "live-ai"/);
  assert.match(storeSource, /SUBJECT_OUT_OF_FRAME[\s\S]*REFERENCE_REVIEW_FAILED/);
  assert.doesNotMatch(storeSource, /kind[^\n]*'reference'|VALUES \([^\n]*'reference'/);
  assert.match(storeSource, /referenceBlobId,[\s\S]*VALUES \(\?, \?, 'input'/);
  assert.match(queueSource, /palimpsest-reference\.png/);
  assert.equal(queueSource.match(/await generateOpenAiPatch\(/gu)?.length, 1);
  assert.match(queueSource, /job\.prompt,\s*deadlineAt/);
  assert.doesNotMatch(queueSource, /planEditPrompt|generalRetryPrompt|referenceRetryPrompt/);
  assert.doesNotMatch(queueSource, /MAX_GENERAL_EDIT_ATTEMPTS|MAX_REFERENCE_ATTEMPTS/);
  assert.doesNotMatch(queueSource, /\/v1\/moderations|omni-moderation/);
  assert.match(queueSource, /form\.append\("quality", "medium"\)/);
  assert.match(queueSource, /form\.append\("model", "gpt-image-2"\)/);
  assert.match(queueSource, /form\.append\("moderation", "auto"\)/);
  assert.doesNotMatch(queueSource, /gpt-image-1\.5/);
  assert.doesNotMatch(queueSource, /form\.append\("background", "transparent"\)/);
  assert.doesNotMatch(queueSource, /form\.append\("input_fidelity"/);
  assert.match(queueSource, /buildOpenAiEditPrompt\([\s\S]*Boolean\(reference\)/);
  assert.doesNotMatch(queueSource, /containmentRetry|retry-containment|containment-retry/);
  assert.match(queueSource, /reviewReferenceEdit/);
  assert.match(queueSource, /sourceImageUrl: imageDataUrl\(sourceBytes\)/);
  assert.match(queueSource, /referencePlacementRegion\(generationRegion\)/);
  assert.match(queueSource, /referenceReviewOutcome\(review\)/);
  assert.match(queueSource, /outcome === "reject-containment"/);
  assert.match(queueSource, /reviewEditOutput/);
  assert.match(queueSource, /!review\.contained \|\| !review\.blended/);
  assert.match(queueSource, /startWorkerHeartbeat/);
  assert.match(queueSource, /WORKER_TOTAL_BUDGET_MS/);
  assert.match(queueSource, /providerStageTimeout\(deadlineAt, IMAGE_EDIT_TIMEOUT_MS\)/);
  assert.match(queueSource, /providerStageTimeout\(deadlineAt, EDIT_REVIEW_TIMEOUT_MS\)/);
  assert.match(queueSource, /use retry for one fresh attempt/);
  assert.match(queueSource, /Last review:/);
  assert.match(queueSource, /SUBJECT_OUT_OF_FRAME/);
  assert.match(queueSource, /https:\/\/api\.openai\.com\/v1\/responses/);
  assert.doesNotMatch(queueSource, /domain\?\.code === "PROVIDER_TEMPORARY" &&/);
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

test("reference patches expand around the intended placement with aspect-aware room", () => {
  assert.equal(REFERENCE_EDIT_MIN_EDGE, 320);
  assert.equal(REFERENCE_TARGET_FILL, 0.35);
  assert.deepEqual(
    referenceSafeEditRegion(
      { x: 326, y: 733, width: 193, height: 228 },
      1,
    ),
    { x: 263, y: 687, width: 320, height: 320 },
  );
  assert.deepEqual(
    referenceSafeEditRegion(
      { x: 326, y: 733, width: 193, height: 228 },
      1.5,
    ),
    { x: 183, y: 687, width: 480, height: 320 },
  );
  assert.deepEqual(
    referenceSafeEditRegion(
      { x: 1900, y: 1800, width: 160, height: 160 },
      1,
    ),
    { x: 1728, y: 1720, width: 320, height: 320 },
  );
});

test("reference preview footprint is the authoritative accepted-layer region", () => {
  assert.deepEqual(
    referencePlacementRegion({ x: 263, y: 687, width: 320, height: 320 }),
    { x: 367, y: 791, width: 112, height: 112 },
  );
  assert.deepEqual(
    referencePlacementRegion({ x: 183, y: 687, width: 480, height: 320 }),
    { x: 339, y: 791, width: 168, height: 112 },
  );
  assert.deepEqual(
    referencePlacementRegion({ x: 298, y: 191, width: 426, height: 640 }),
    { x: 437, y: 399, width: 149, height: 224 },
  );
});

test("server-side reference sizing rejects undersized patches", () => {
  assert.equal(assertReferenceEditRegion({ width: 320, height: 320 }), true);
  expectCode(
    () => assertReferenceEditRegion({ width: 319, height: 512 }),
    "REFERENCE_REGION_TOO_SMALL",
  );
  expectCode(
    () => assertReferenceEditRegion({ width: 512, height: 319 }),
    "REFERENCE_REGION_TOO_SMALL",
  );
});

test("patch selection preserves user coordinates when it overlaps a live reservation", () => {
  const patch = { x: 100, y: 100, width: 200, height: 200 };
  const reserved = { x: 300, y: 180, width: 180, height: 180 };
  const moved = positionEditRegion(patch, 240, 140);
  const resized = resizeEditRegion(moved, 320, 280);

  assert.deepEqual(moved, { x: 240, y: 140, width: 200, height: 200 });
  assert.deepEqual(resized, { x: 240, y: 140, width: 320, height: 280 });
  assert.equal(regionsOverlap(moved, reserved), true);
  assert.equal(regionsOverlap(resized, reserved), true);
});

test("collaboration UI never silently relocates a selected patch", async () => {
  const source = await readFile(new URL("../app/Palimpsest.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /positionEditRegionAvoidingRegions/);
  assert.doesNotMatch(source, /resizeEditRegionAvoidingRegions/);
  assert.doesNotMatch(source, /patch moved to open space/);
  assert.match(source, /your patch stayed exactly where you placed it/);
  assert.match(source, /!conflictingRegion/);
});

test("reference preview remains movable during the prompt step", async () => {
  const source = await readFile(new URL("../app/Palimpsest.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /const patchCanMove =\s*!submitted && \(step === 1 \|\| \(step === 3 && Boolean\(referenceImage\)\)\)/,
  );
  assert.match(source, /referenceActive: Boolean\(referenceImage\)/);
  assert.match(
    source,
    /current\.step === 1 \|\| \(current\.step === 3 && current\.referenceActive\)/,
  );
  assert.match(source, /if \(!patchCanMove\) return/);
  assert.match(source, /tabIndex=\{patchCanMove \? 0 : -1\}/);
  assert.match(source, /Drag to reposition the exact preview/);
  assert.match(source, /drag to position · exact preview/);
});

test("adaptive generation frames give small edits a high-resolution working crop", () => {
  assert.deepEqual(
    generationFrameForRegion({ x: 896, y: 832, width: 256, height: 384 }),
    { x: 717, y: 717, width: 615, height: 615 },
  );

  const corners = [
    [{ x: 0, y: 0, width: 64, height: 64 }, { x: -96, y: -96, width: 256, height: 256 }],
    [{ x: 1984, y: 0, width: 64, height: 64 }, { x: 1888, y: -96, width: 256, height: 256 }],
    [{ x: 0, y: 1984, width: 64, height: 64 }, { x: -96, y: 1888, width: 256, height: 256 }],
    [{ x: 1984, y: 1984, width: 64, height: 64 }, { x: 1888, y: 1888, width: 256, height: 256 }],
  ];
  for (const [region, expectedFrame] of corners) {
    assert.deepEqual(generationFrameForRegion(region), expectedFrame);
  }

  assert.deepEqual(
    generationFrameForRegion({ x: 167, y: 1035, width: 161, height: 305 }),
    { x: 4, y: 944, width: 488, height: 488 },
  );

  const edgeRegion = { x: 1888, y: 1472, width: 160, height: 320 };
  const edgeFrame = generationFrameForRegion(edgeRegion);
  assert.deepEqual(edgeFrame, { x: 1712, y: 1376, width: 512, height: 512 });
  assert.deepEqual(regionInGenerationFrame(edgeRegion, edgeFrame), {
    x: 352,
    y: 192,
    width: 320,
    height: 640,
  });
});

test("global masks scale into provider pixels without losing stroke geometry", () => {
  const region = { x: 896, y: 832, width: 256, height: 384 };
  const frame = generationFrameForRegion(region);
  const providerRegion = regionInGenerationFrame(region, frame);
  assert.deepEqual(providerRegion, { x: 298, y: 191, width: 426, height: 640 });
  assert.deepEqual(regionInGenerationFrame(region), providerRegion);

  const providerMask = maskInGenerationFrame(
    region,
    [{ width: 16, points: [{ x: 0, y: 0 }, { x: 256, y: 384 }] }],
    frame,
  );
  assert.deepEqual(providerMask, {
    region: providerRegion,
    strokes: [{
      width: 27,
      points: [{ x: 0, y: 0 }, { x: 426, y: 640 }],
    }],
  });

  const svg = createDisplayMaskSvg({
    region: providerMask.region,
    fill: true,
    strokes: [],
  });
  assert.match(svg, /<rect x="298" y="191" width="426" height="640"\/>/);
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
