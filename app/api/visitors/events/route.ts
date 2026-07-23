import { DomainError } from "@/lib/palimpsest/domain.mjs";
import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import {
  isVisitorInteractionType,
  recordVisitorEvent,
} from "@/lib/palimpsest/store";

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    const body = (await request.json()) as { event?: unknown } | null;
    if (!body || !isVisitorInteractionType(body.event)) {
      throw new DomainError("INVALID_REQUEST", "That visitor interaction is not supported.");
    }
    await recordVisitorEvent(getRuntimeEnv(), request, body.event, {
      sessionId: request.headers.get("X-Palimpsest-Session"),
    });
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
