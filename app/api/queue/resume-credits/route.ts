import { processQueue } from "@/lib/palimpsest/queue";
import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import {
  ensurePalimpsest,
  resumeCreditBlockedJobs,
} from "@/lib/palimpsest/store";

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    const env = getRuntimeEnv();
    await ensurePalimpsest(env, request.url);
    const resumed = await resumeCreditBlockedJobs(env, 8);
    const result = await processQueue(env, 8);
    return Response.json(
      {
        resumed,
        processed: result.claimed,
        completed: result.completed,
        workerFailures: result.workerFailures,
        message: resumed
          ? `${resumed} saved ${resumed === 1 ? "edit was" : "edits were"} returned to the queue.`
          : result.claimed
            ? `${result.claimed} saved ${result.claimed === 1 ? "edit was" : "edits were"} restarted.`
            : "No edits are waiting for generation credits.",
      },
      {
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
