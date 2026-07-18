import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import { listHistory } from "@/lib/palimpsest/store";

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    const history = await listHistory(getRuntimeEnv(), request.url);
    return Response.json(history, {
      headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
