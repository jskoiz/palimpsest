import {
  DomainError,
  normalizeDisplayName,
} from "@/lib/palimpsest/domain.mjs";
import { contributionRatePolicy } from "@/lib/palimpsest/rate-policy.mjs";
import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import {
  enforceRateLimit,
  ensurePalimpsest,
  insertRevertJob,
  recordVisitorEvent,
  requesterHash,
} from "@/lib/palimpsest/store";

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    const env = getRuntimeEnv();
    await ensurePalimpsest(env, request.url);
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new DomainError("INVALID_REQUEST", "A valid Idempotency-Key header is required.");
    }
    const body = (await request.json()) as {
      artworkId?: string;
      baseRevisionId?: string;
      targetRevisionId?: string;
      displayName?: string;
    };
    if (
      body.artworkId !== "palimpsest" ||
      typeof body.baseRevisionId !== "string" ||
      typeof body.targetRevisionId !== "string"
    ) {
      throw new DomainError("INVALID_REQUEST", "Base and restore-target revisions are required.");
    }
    const hash = await requesterHash(env, request);
    const ratePolicy = contributionRatePolicy(env, request, "revert");
    for (const limit of ratePolicy.limits) {
      await enforceRateLimit(env, hash, limit.scope, limit.limit, limit.windowMs);
    }
    const job = await insertRevertJob(env, {
      baseRevisionId: body.baseRevisionId,
      targetRevisionId: body.targetRevisionId,
      displayName: normalizeDisplayName(body.displayName),
      requesterHash: hash,
      idempotencyKey,
    });
    try {
      await recordVisitorEvent(env, request, "restore_requested", {
        sessionId: request.headers.get("X-Palimpsest-Session"),
        jobId: job.id,
      });
    } catch (logError) {
      console.warn(`[palimpsest:${requestId}] visitor activity logging failed`, logError);
    }
    console.info(`[palimpsest:${requestId}] contribution accepted`, {
      kind: "revert",
      ratePolicy: ratePolicy.name,
    });
    return Response.json(
      { job, notice: "The earlier appearance will be restored as a new revision. Existing history remains unchanged." },
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
