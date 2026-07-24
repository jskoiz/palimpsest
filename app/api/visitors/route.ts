import { isVerifiedAdminRequest } from "@/lib/palimpsest/admin.mjs";
import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import { getVisitorActivity } from "@/lib/palimpsest/store";

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    const env = getRuntimeEnv();
    if (!isVerifiedAdminRequest(env, request)) {
      return Response.json(
        { error: { code: "FORBIDDEN", message: "Visitor activity is restricted to site administrators." } },
        { status: 403, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
      );
    }
    return Response.json(await getVisitorActivity(env), {
      headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
