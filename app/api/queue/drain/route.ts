import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import { ensurePalimpsest } from "@/lib/palimpsest/store";

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    await ensurePalimpsest(getRuntimeEnv(), request.url);
    return Response.json(
      { accepted: true, message: "The serial queue has been nudged." },
      { status: 202, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
    );
  } catch (error) {
    return jsonError(error, requestId);
  }
}
