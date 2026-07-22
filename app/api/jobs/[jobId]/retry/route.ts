import { DomainError } from "@/lib/palimpsest/domain.mjs";
import { contributionRatePolicy } from "@/lib/palimpsest/rate-policy.mjs";
import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import {
  ensurePalimpsest,
  requesterHash,
  retryFailedEditJob,
} from "@/lib/palimpsest/store";

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const requestId = createRequestId();
  try {
    const env = getRuntimeEnv();
    await ensurePalimpsest(env, request.url);
    const retryToken = request.headers.get("X-Palimpsest-Retry-Token")?.trim() ?? "";
    if (retryToken.length < 16 || retryToken.length > 128) {
      throw new DomainError("NOT_FOUND", "That retryable contribution could not be found.");
    }
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new DomainError("INVALID_REQUEST", "A valid Idempotency-Key header is required.");
    }
    const { jobId } = await context.params;
    const hash = await requesterHash(env, request);
    const ratePolicy = contributionRatePolicy(env, request, "edit");
    const job = await retryFailedEditJob(env, {
      jobId,
      requesterHash: hash,
      retryToken,
      idempotencyKey,
      rateLimits: ratePolicy.limits,
      requestId,
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
