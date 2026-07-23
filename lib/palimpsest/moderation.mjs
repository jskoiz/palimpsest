// @ts-check

import { DomainError } from "./domain.mjs";

export const PLACEMENT_MODERATION_MODEL = "omni-moderation-latest";
export const PLACEMENT_MODERATION_TIMEOUT_MS = 10_000;

/** @param {Uint8Array} bytes */
function pngDataUrl(bytes) {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

function moderationUnavailable() {
  return new DomainError(
    "PROVIDER_TEMPORARY",
    "The uploaded placement could not be safety checked. Nothing was added to history; retry in a moment.",
  );
}

/**
 * Fail-closed multimodal moderation for the exact bytes that would be
 * committed. Both the normalized prompt and PNG are supplied in one request.
 *
 * @param {{
 *   apiKey: string | undefined,
 *   prompt: string,
 *   pngBytes: Uint8Array,
 *   fetcher?: typeof fetch,
 * }} input
 * @returns {Promise<{requestId?: string}>}
 */
export async function moderatePlacement(input) {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) throw moderationUnavailable();

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    PLACEMENT_MODERATION_TIMEOUT_MS,
  );
  let response;
  let body;
  try {
    response = await (input.fetcher ?? fetch)(
      "https://api.openai.com/v1/moderations",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: PLACEMENT_MODERATION_MODEL,
          input: [
            { type: "text", text: input.prompt },
            {
              type: "image_url",
              image_url: { url: pngDataUrl(input.pngBytes) },
            },
          ],
        }),
        signal: controller.signal,
      },
    );
    body = await response.json().catch(() => null);
  } catch {
    throw moderationUnavailable();
  } finally {
    clearTimeout(timeout);
  }

  const result =
    body &&
    typeof body === "object" &&
    Array.isArray(body.results)
      ? body.results[0]
      : null;
  if (
    !response.ok ||
    !result ||
    typeof result !== "object" ||
    typeof result.flagged !== "boolean"
  ) {
    throw moderationUnavailable();
  }
  if (result.flagged) {
    throw new DomainError(
      "CONTENT_POLICY",
      "This uploaded placement could not be added because it did not meet safety requirements.",
    );
  }
  return {
    requestId: response.headers.get("x-request-id") ?? undefined,
  };
}
