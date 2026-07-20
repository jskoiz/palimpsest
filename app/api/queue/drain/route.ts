import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import { processQueue } from "@/lib/palimpsest/queue";
import { ensurePalimpsest } from "@/lib/palimpsest/store";

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    const env = getRuntimeEnv();
    await ensurePalimpsest(env, request.url);
    const result = await processQueue(env, 4);
    return Response.json(
      {
        processed: result.claimed,
        completed: result.completed,
        workerFailures: result.workerFailures,
        message: "Independent reservations were processed concurrently.",
      },
      { headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
    );
  } catch (error) {
    return jsonError(error, requestId);
  }
}
