import {
  DomainError,
  assertReferenceEditRegion,
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
    if (!env.OPENAI_API_KEY?.trim()) {
      throw new DomainError(
        "AI_NOT_CONFIGURED",
        "Live AI editing is temporarily unavailable.",
      );
    }
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
    const metaValue = form.get("meta");
    const sourceValue = form.get("source");
    const maskValue = form.get("mask");
    const referenceValue = form.get("reference");
    if (typeof metaValue !== "string") {
      throw new DomainError("INVALID_REQUEST", "Edit metadata is required.");
    }
    if (!(sourceValue instanceof File) || !(maskValue instanceof File)) {
      throw new DomainError("INVALID_MASK", "A source context frame and PNG mask are required.");
    }
    if (sourceValue.type !== "image/png" || maskValue.type !== "image/png") {
      throw new DomainError("INVALID_MASK", "Source and mask files must be PNG images.");
    }
    if (referenceValue !== null && !(referenceValue instanceof File)) {
      throw new DomainError("INVALID_REQUEST", "The reference image upload is invalid.");
    }
    if (referenceValue instanceof File && referenceValue.type !== "image/png") {
      throw new DomainError("INVALID_REQUEST", "The reference image must be a PNG file.");
    }
    if (sourceValue.size > 8 * 1024 * 1024 || maskValue.size > 2 * 1024 * 1024) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "The source frame or mask is too large.");
    }
    if (referenceValue instanceof File && referenceValue.size > 6 * 1024 * 1024) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "The reference image is too large.");
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
      fill: meta.fill,
      strokes: meta.strokes,
    });
    if (referenceValue instanceof File) {
      assertReferenceEditRegion(validated.region);
    }
    const [sourceBytes, maskBytes, referenceBytes] = await Promise.all([
      sourceValue.arrayBuffer().then((value) => new Uint8Array(value)),
      maskValue.arrayBuffer().then((value) => new Uint8Array(value)),
      referenceValue instanceof File
        ? referenceValue.arrayBuffer().then((value) => new Uint8Array(value))
        : Promise.resolve(undefined),
    ]);
    for (const bytes of [sourceBytes, maskBytes]) {
      const dimensions = readPngDimensions(bytes);
      if (dimensions.width !== 1024 || dimensions.height !== 1024) {
        throw new DomainError("INVALID_MASK", "Source and mask images must be exactly 1024 by 1024 pixels.");
      }
    }
    if (referenceBytes) {
      const dimensions = readPngDimensions(referenceBytes);
      if (dimensions.width !== 1024 || dimensions.height !== 1024) {
        throw new DomainError(
          "INVALID_REQUEST",
          "The reference image must be exactly 1024 by 1024 pixels.",
        );
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
      referenceBytes,
      rateLimits: ratePolicy.limits,
      requestId,
      retryToken,
    });
    console.info(`[palimpsest:${requestId}] contribution accepted`, {
      kind: "edit",
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
