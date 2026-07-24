import { DomainError } from "@/lib/palimpsest/domain.mjs";
import { hasAutomationAccess } from "@/lib/palimpsest/automation-auth.mjs";
import { processQueue } from "@/lib/palimpsest/queue";
import {
  createRequestId,
  getRuntimeEnv,
  jsonError,
} from "@/lib/palimpsest/runtime";
import {
  ensurePalimpsest,
  getPublicJob,
  retryFailedEditJobAsAutomation,
} from "@/lib/palimpsest/store";

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const requestId = createRequestId();
  try {
    const env = getRuntimeEnv();
    if (
      !(await hasAutomationAccess(
        request.headers.get("Authorization"),
        env.AUTOMATION_RETRY_TOKEN,
      ))
    ) {
      throw new DomainError("NOT_FOUND", "That retryable contribution could not be found.");
    }

    await ensurePalimpsest(env, request.url);
    const { jobId } = await context.params;
    const job = await retryFailedEditJobAsAutomation(env, {
      jobId,
      idempotencyKey: `automation-retry:${jobId}`,
      requestId,
    });
    await processQueue(env, 1);
    const processedJob = await getPublicJob(env, job.id);
    return Response.json(
      { job: processedJob },
      {
        status: 202,
        headers: {
          "Cache-Control": "no-store",
          "X-Request-Id": requestId,
        },
      },
    );
  } catch (error) {
    return jsonError(error, requestId);
  }
}
