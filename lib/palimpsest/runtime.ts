import { env as cloudflareEnv } from "cloudflare:workers";
import { DomainError } from "./domain.mjs";

export interface AppEnv {
  ASSETS?: Fetcher;
  DB: D1Database;
  BLOBS: R2Bucket;
  OPENAI_API_KEY?: string;
  RATE_LIMIT_SALT?: string;
}

export function getRuntimeEnv(): AppEnv {
  const runtime = cloudflareEnv as unknown as Partial<AppEnv>;
  if (!runtime.DB || !runtime.BLOBS) {
    const missing = [
      !runtime.DB ? "DB" : null,
      !runtime.BLOBS ? "BLOBS" : null,
    ].filter(Boolean);
    throw new DomainError(
      "SERVICE_UNAVAILABLE",
      `Palimpsest storage is not available in this environment. Missing bindings: ${missing.join(", ")}.`,
    );
  }
  return runtime as AppEnv;
}

export function createRequestId(): string {
  return crypto.randomUUID();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function safeRegionBusyDetails(error: DomainError): Record<string, unknown> | undefined {
  if (error.code !== "REGION_BUSY") return undefined;
  const details = asRecord(asRecord(error)?.details);
  const conflict = asRecord(details?.conflict);
  const region = asRecord(conflict?.region);
  if (!conflict || !region) return undefined;

  const numbers = [region.x, region.y, region.width, region.height];
  if (
    typeof conflict.jobId !== "string" ||
    typeof conflict.author !== "string" ||
    typeof conflict.state !== "string" ||
    typeof conflict.createdAt !== "string" ||
    typeof conflict.updatedAt !== "string" ||
    !numbers.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    return undefined;
  }

  return {
    conflict: {
      jobId: conflict.jobId,
      author: conflict.author,
      state: conflict.state,
      region: {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      },
      createdAt: conflict.createdAt,
      updatedAt: conflict.updatedAt,
    },
  };
}

export function jsonError(
  error: unknown,
  requestId: string,
  details?: Record<string, unknown>,
): Response {
  const domainError = error instanceof DomainError ? error : null;
  const code = domainError?.code ?? "INTERNAL_ERROR";
  const status =
    code === "STALE_BASE_REVISION" ||
    code === "IDEMPOTENCY_CONFLICT" ||
    code === "REGION_BUSY"
      ? 409
      : code === "RATE_LIMITED"
        ? 429
        : code === "NOT_FOUND"
          ? 404
          : code === "PAYLOAD_TOO_LARGE"
            ? 413
            : code === "SERVICE_UNAVAILABLE" || code === "AI_NOT_CONFIGURED"
              ? 503
              : code === "INTERNAL_ERROR"
                ? 500
                : 400;
  const message =
    domainError?.message ??
    "Palimpsest could not complete that request. Nothing was added to history.";
  const publicDetails = details ?? (domainError ? safeRegionBusyDetails(domainError) : undefined);

  return Response.json(
    {
      error: {
        code,
        message,
        requestId,
        ...(publicDetails ? { details: publicDetails } : {}),
      },
    },
    { status },
  );
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  const ownedBytes = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", ownedBytes.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function readPngDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.byteLength < 24 ||
    signature.some((value, index) => bytes[index] !== value) ||
    String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
  ) {
    throw new DomainError("INVALID_MASK", "The uploaded image must be a valid PNG file.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function publicJobMessage(state: string): string | null {
  if (state === "queued") return "Your contribution is in the queue.";
  if (state === "moderating") return "Checking the contribution before it enters the work.";
  if (state === "generating") return "Making the next revision.";
  if (state === "committing") return "Adding the revision to permanent history.";
  if (state === "succeeded") return "This revision is now part of Palimpsest.";
  return null;
}

export function hasUnsafePromptSignals(prompt: string): boolean {
  const compact = prompt.toLocaleLowerCase();
  const blocked = [
    /\b(?:child sexual|sexualize(?:d)? minor|csam)\b/u,
    /\b(?:kill myself|suicide instructions)\b/u,
    /\b(?:doxx?|home address|credit card number)\b/u,
  ];
  return blocked.some((pattern) => pattern.test(compact));
}
