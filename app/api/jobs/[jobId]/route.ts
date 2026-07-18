import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import { ensurePalimpsest, getPublicJob } from "@/lib/palimpsest/store";

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const requestId = createRequestId();
  try {
    const env = getRuntimeEnv();
    await ensurePalimpsest(env, request.url);
    const { jobId } = await context.params;
    const job = await getPublicJob(env, jobId);
    return Response.json({ job }, {
      headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
