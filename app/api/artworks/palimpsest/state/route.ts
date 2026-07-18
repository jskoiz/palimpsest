import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import { getArtworkState } from "@/lib/palimpsest/store";

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    const revisionId = new URL(request.url).searchParams.get("revisionId");
    const state = await getArtworkState(getRuntimeEnv(), request.url, revisionId);
    return Response.json(state, {
      headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
