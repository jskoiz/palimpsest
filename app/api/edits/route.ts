import {
  DomainError,
  normalizeDisplayName,
  normalizePrompt,
  validateRegion,
} from "@/lib/palimpsest/domain.mjs";
import {
  createRequestId,
  getRuntimeEnv,
  hasUnsafePromptSignals,
  jsonError,
  readPngDimensions,
} from "@/lib/palimpsest/runtime";
import {
  MAX_PLACEMENT_PNG_BYTES,
  validatePlacementPng,
} from "@/lib/palimpsest/png.mjs";
import { contributionRatePolicy } from "@/lib/palimpsest/rate-policy.mjs";
import {
  ensurePalimpsest,
  insertEditJob,
  requesterHash,
} from "@/lib/palimpsest/store";

type EditMeta = {
  artworkId?: string;
  baseRevisionId?: string;
  displayName?: string;
  prompt?: string;
  region?: { x?: number; y?: number; width?: number; height?: number };
  fill?: boolean;
  strokes?: Array<{
    width?: number;
    points?: Array<{ x?: number; y?: number }>;
  }>;
};

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    const env = getRuntimeEnv();
    await ensurePalimpsest(env, request.url);
    const contentLength = Number(request.headers.get("Content-Length") ?? 0);
    if (contentLength > 18 * 1024 * 1024) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "The edit upload is too large.");
    }
    if (!request.headers.get("Content-Type")?.includes("multipart/form-data")) {
      throw new DomainError("INVALID_REQUEST", "Submit the edit as multipart form data.");
    }
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new DomainError("INVALID_REQUEST", "A valid Idempotency-Key header is required.");
    }
    const retryToken = request.headers.get("X-Palimpsest-Retry-Token")?.trim() ?? "";
    if (retryToken.length < 16 || retryToken.length > 128) {
      throw new DomainError(
        "INVALID_REQUEST",
        "A valid X-Palimpsest-Retry-Token header is required.",
      );
    }

    const form = await request.formData();
    const allowedFields = new Set(["meta", "source", "mask", "placement"]);
    if ([...form.keys()].some((name) => !allowedFields.has(name))) {
      throw new DomainError(
        "INVALID_REQUEST",
        "The edit upload contains an unsupported multipart field.",
      );
    }
    const metaValues = form.getAll("meta");
    const sourceValues = form.getAll("source");
    const maskValues = form.getAll("mask");
    const placementValues = form.getAll("placement");
    if (
      metaValues.length !== 1 ||
      sourceValues.length > 1 ||
      maskValues.length > 1 ||
      placementValues.length > 1
    ) {
      throw new DomainError(
        "INVALID_REQUEST",
        "Each edit multipart field may be supplied only once.",
      );
    }
    const metaValue = metaValues[0];
    const sourceValue = sourceValues[0] ?? null;
    const maskValue = maskValues[0] ?? null;
    const placementValue = placementValues[0] ?? null;
    if (typeof metaValue !== "string") {
      throw new DomainError("INVALID_REQUEST", "Edit metadata is required.");
    }
    for (const value of [sourceValue, maskValue, placementValue]) {
      if (value !== null && !(value instanceof File)) {
        throw new DomainError(
          "INVALID_REQUEST",
          "Edit image fields must contain files.",
        );
      }
    }
    const hasPromptInputs =
      sourceValue instanceof File && maskValue instanceof File;
    const hasPlacement = placementValue instanceof File;
    if (
      hasPlacement
        ? sourceValue !== null || maskValue !== null
        : !hasPromptInputs
    ) {
      throw new DomainError(
        "INVALID_REQUEST",
        "Submit exactly one placement PNG, or one source PNG with one mask PNG.",
      );
    }
    if (!env.OPENAI_API_KEY?.trim()) {
      throw new DomainError(
        "AI_NOT_CONFIGURED",
        "Safety-checked image editing is temporarily unavailable.",
      );
    }
    if (hasPlacement && placementValue.type !== "image/png") {
      throw new DomainError("INVALID_REQUEST", "The placement must be a PNG file.");
    }
    if (
      hasPromptInputs &&
      (sourceValue.type !== "image/png" || maskValue.type !== "image/png")
    ) {
      throw new DomainError("INVALID_MASK", "Source and mask files must be PNG images.");
    }
    if (
      hasPromptInputs &&
      (sourceValue.size > 8 * 1024 * 1024 || maskValue.size > 2 * 1024 * 1024)
    ) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "The source frame or mask is too large.");
    }
    if (hasPlacement && placementValue.size > MAX_PLACEMENT_PNG_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "The placement image is too large.");
    }

    let meta: EditMeta;
    try {
      meta = JSON.parse(metaValue) as EditMeta;
    } catch {
      throw new DomainError("INVALID_REQUEST", "Edit metadata is not valid JSON.");
    }
    if (meta.artworkId !== "palimpsest" || typeof meta.baseRevisionId !== "string") {
      throw new DomainError("INVALID_REQUEST", "The artwork and base revision are required.");
    }
    if (Object.hasOwn(meta, "executionMode")) {
      throw new DomainError(
        "INVALID_REQUEST",
        "Generation mode is server-controlled and must not be included.",
      );
    }
    const prompt = normalizePrompt(meta.prompt);
    const displayName = normalizeDisplayName(meta.displayName);
    if (hasUnsafePromptSignals(prompt)) {
      throw new DomainError(
        "CONTENT_POLICY",
        "This prompt cannot be submitted. Describe a safe visual change without personal information.",
      );
    }
    if (Object.hasOwn(meta, "tile")) {
      throw new DomainError(
        "INVALID_REQUEST",
        "Edit regions use global artwork coordinates and must not include a tile.",
      );
    }
    const validated = validateRegion({
      region: meta.region,
      fill: hasPlacement ? true : meta.fill,
      strokes: hasPlacement ? [] : meta.strokes,
    });
    let sourceBytes: Uint8Array | undefined;
    let maskBytes: Uint8Array | undefined;
    let placementBytes: Uint8Array | undefined;
    if (hasPlacement) {
      placementBytes = new Uint8Array(await placementValue.arrayBuffer());
      await validatePlacementPng(placementBytes);
    } else if (hasPromptInputs) {
      [sourceBytes, maskBytes] = await Promise.all([
        sourceValue.arrayBuffer().then((value) => new Uint8Array(value)),
        maskValue.arrayBuffer().then((value) => new Uint8Array(value)),
      ]);
    }
    for (const bytes of [sourceBytes, maskBytes]) {
      if (!bytes) continue;
      const dimensions = readPngDimensions(bytes);
      if (dimensions.width !== 1024 || dimensions.height !== 1024) {
        throw new DomainError("INVALID_MASK", "Source and mask images must be exactly 1024 by 1024 pixels.");
      }
    }

    const hash = await requesterHash(env, request);
    const ratePolicy = contributionRatePolicy(env, request, "edit");
    const job = await insertEditJob(env, {
      baseRevisionId: meta.baseRevisionId,
      displayName,
      prompt,
      region: validated.region,
      fill: validated.fill,
      strokes: validated.strokes,
      idempotencyKey,
      requesterHash: hash,
      sourceBytes,
      maskBytes,
      placementBytes,
      rateLimits: ratePolicy.limits,
      requestId,
      retryToken,
    });
    console.info(`[palimpsest:${requestId}] contribution accepted`, {
      kind: "edit",
      mode: hasPlacement ? "placement" : "openai",
      ratePolicy: ratePolicy.name,
    });
    return Response.json(
      { job },
      { status: 202, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
    );
  } catch (error) {
    const response = jsonError(error, requestId);
    if (error instanceof DomainError && error.code === "RATE_LIMITED") {
      response.headers.set("Retry-After", "600");
    }
    return response;
  }
}
