import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import { getDebugSnapshot } from "@/lib/palimpsest/store";

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    return Response.json(
      await getDebugSnapshot(getRuntimeEnv(), request.url),
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
