import { DomainError } from "@/lib/palimpsest/domain.mjs";
import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import {
  isVisitorInteractionType,
  recordVisitorEvent,
} from "@/lib/palimpsest/store";

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
      throw new DomainError("INVALID_REQUEST", "Submit visitor interactions as JSON.");
    }
    const contentLength = Number(request.headers.get("Content-Length") ?? 0);
    if (contentLength > 1_024) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "The visitor interaction is too large.");
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 1_024) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "The visitor interaction is too large.");
    }
    let body: { event?: unknown } | null;
    try {
      body = JSON.parse(rawBody) as { event?: unknown } | null;
    } catch {
      throw new DomainError("INVALID_REQUEST", "The visitor interaction is not valid JSON.");
    }
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
