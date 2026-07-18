import { DomainError } from "@/lib/palimpsest/domain.mjs";
import { createRequestId, getRuntimeEnv, jsonError } from "@/lib/palimpsest/runtime";
import { ensurePalimpsest, getBlobRecord } from "@/lib/palimpsest/store";

export async function GET(
  request: Request,
  context: { params: Promise<{ blobId: string }> },
) {
  const requestId = createRequestId();
  try {
    const env = getRuntimeEnv();
    await ensurePalimpsest(env, request.url);
    const { blobId } = await context.params;
    const record = await getBlobRecord(env, blobId);
    if (!record || record.kind === "mask" || record.kind === "input") {
      throw new DomainError("NOT_FOUND", "That image layer could not be found.");
    }
    const object = await env.BLOBS.get(record.r2Key);
    if (!object) throw new DomainError("NOT_FOUND", "That image layer is unavailable.");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", record.contentType);
    headers.set("Content-Length", String(record.byteLength));
    headers.set("ETag", `"${record.sha256}"`);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(object.body, { headers });
  } catch (error) {
    return jsonError(error, requestId);
  }
}
