import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import { getActivity } from "@/lib/palimpsest/store";

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    const activity = await getActivity(getRuntimeEnv(), request.url);
    return Response.json(activity, {
      headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
