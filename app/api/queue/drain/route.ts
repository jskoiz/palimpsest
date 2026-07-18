import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import { processQueue } from "@/lib/palimpsest/queue";
import { ensurePalimpsest } from "@/lib/palimpsest/store";

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    const env = getRuntimeEnv();
    await ensurePalimpsest(env, request.url);
    await processQueue(env, 1);
    return Response.json(
      { processed: true, message: "The serial queue has been checked." },
      { headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
    );
  } catch (error) {
    return jsonError(error, requestId);
  }
}
