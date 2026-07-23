export const EDIT_REVIEW_MODEL = "gpt-5.6";

function extractResponseText(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;
  const output = Array.isArray(responseBody.output) ? responseBody.output : [];
  const fragments = [];

  for (const item of output) {
    if (!item || typeof item !== "object" || item.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        part.type === "output_text" &&
        typeof part.text === "string"
      ) {
        const text = part.text.trim();
        if (text) fragments.push(text);
      }
    }
  }

  const text = fragments.join("\n").trim();
  return text || null;
}

const EDIT_OUTPUT_REVIEW_INSTRUCTIONS = `Inspect a contextual image edit before it is accepted.
The first image is the generated current-canvas frame. The second image shows the editable area as transparency surrounded by protected black pixels at the same 1024 by 1024 coordinates.
Judge only the contributor's requested change inside the editable area.
Any discrete requested subject, including handwriting, printed text, symbols, objects, characters, and their shadows or marks, must be complete and surrounded by clear background space on every side.
For requested text, every requested word, letter, punctuation mark, decorative stroke, and underline must be fully visible and must not end abruptly at the editable boundary.
Any requested subject touching, crossing, or appearing truncated by an editable boundary fails containment, even if most of the subject is visible.
The edit must blend naturally into the current canvas with no visible rectangular patch, matte, frame, halo, color wash, or abrupt tonal seam.
If the request is only a diffuse texture, lighting, background, or style treatment with no discrete subject, containment passes unless the treatment has a hard patch boundary.
Ignore unrelated pre-existing content outside the editable area.`;

export function buildEditOutputReviewRequest({
  requestedChange,
  generatedImageUrl,
  providerMaskUrl,
  editableRegion,
}) {
  const right = editableRegion.x + editableRegion.width;
  const bottom = editableRegion.y + editableRegion.height;
  return {
    model: EDIT_REVIEW_MODEL,
    reasoning: { effort: "low" },
    instructions: EDIT_OUTPUT_REVIEW_INSTRUCTIONS,
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text: `Requested change: ${requestedChange}\nThe editable area in the first image is x=${editableRegion.x}, y=${editableRegion.y}, width=${editableRegion.width}, height=${editableRegion.height}; its right edge is x=${right} and bottom edge is y=${bottom}. Return whether the entire requested subject and all requested text are complete with clear space on every side, and whether the result blends into the current canvas without a visible patch boundary.`,
        },
        { type: "input_image", image_url: generatedImageUrl, detail: "high" },
        { type: "input_image", image_url: providerMaskUrl, detail: "low" },
      ],
    }],
    max_output_tokens: 500,
    store: false,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "edit_output_review",
        strict: true,
        schema: {
          type: "object",
          properties: {
            contained: { type: "boolean" },
            blended: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["contained", "blended", "reason"],
          additionalProperties: false,
        },
      },
    },
  };
}

export function extractEditOutputReview(responseBody) {
  const text = extractResponseText(responseBody);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (
      typeof parsed?.contained !== "boolean" ||
      typeof parsed?.blended !== "boolean" ||
      typeof parsed?.reason !== "string"
    ) {
      return null;
    }
    return {
      contained: parsed.contained,
      blended: parsed.blended,
      reason: parsed.reason.trim(),
    };
  } catch {
    return null;
  }
}

const REFERENCE_EDIT_REVIEW_INSTRUCTIONS = `Inspect a contextual image edit before it is accepted.
The first image is the generated current-canvas frame, the second is the contributor's uploaded visual reference, and the third shows the editable area as transparency surrounded by protected black pixels.
Judge the requested subject only inside the editable area.
The subject must be complete, uncropped, and surrounded by clear space on every side.
If the requested subject contains text, every requested word, letter, punctuation mark, decorative stroke, and underline must be fully visible and must not end abruptly at the editable boundary.
It must remain unmistakably faithful to the primary subject named or implied by the requested change: preserve distinctive silhouette, geometry, proportions, perspective, materials, control count and arrangement, symbols, labels, and fine construction details instead of redesigning or substituting them. Do not require a reference background, display stand, or secondary prop unless the requested change includes it.
It must also blend naturally into the current canvas with no visible rectangular patch, matte, frame, halo, color wash, or abrupt tonal seam.
Any requested subject touching or crossing the editable boundary fails containment.
Any material change to the reference subject's identity or component layout fails fidelity.
Ignore unrelated pre-existing content outside the editable area.`;

export function buildReferenceEditReviewRequest({
  requestedChange,
  generatedImageUrl,
  referenceImageUrl,
  providerMaskUrl,
  editableRegion,
}) {
  const right = editableRegion.x + editableRegion.width;
  const bottom = editableRegion.y + editableRegion.height;
  return {
    model: EDIT_REVIEW_MODEL,
    reasoning: { effort: "low" },
    instructions: REFERENCE_EDIT_REVIEW_INSTRUCTIONS,
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text: `Requested change: ${requestedChange}\nThe editable area in the first image is x=${editableRegion.x}, y=${editableRegion.y}, width=${editableRegion.width}, height=${editableRegion.height}; its right edge is x=${right} and bottom edge is y=${bottom}. Return whether the subject is fully contained with clear space on every side, visually faithful to the uploaded reference, and naturally blended into the current canvas without a visible patch boundary.`,
        },
        { type: "input_image", image_url: generatedImageUrl, detail: "high" },
        { type: "input_image", image_url: referenceImageUrl, detail: "high" },
        { type: "input_image", image_url: providerMaskUrl, detail: "low" },
      ],
    }],
    max_output_tokens: 500,
    store: false,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "reference_edit_review",
        strict: true,
        schema: {
          type: "object",
          properties: {
            contained: { type: "boolean" },
            faithful: { type: "boolean" },
            blended: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["contained", "faithful", "blended", "reason"],
          additionalProperties: false,
        },
      },
    },
  };
}

export function extractReferenceEditReview(responseBody) {
  const text = extractResponseText(responseBody);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (
      typeof parsed?.contained !== "boolean" ||
      typeof parsed?.faithful !== "boolean" ||
      typeof parsed?.blended !== "boolean" ||
      typeof parsed?.reason !== "string"
    ) {
      return null;
    }
    return {
      contained: parsed.contained,
      faithful: parsed.faithful,
      blended: parsed.blended,
      reason: parsed.reason.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * A clean containment miss gets one smaller-scale generation. Fidelity or
 * blending failures stop immediately rather than spending another image pass.
 * @param {{contained: boolean, faithful: boolean, blended: boolean}} review
 * @param {boolean} containmentRetryUsed
 */
export function referenceReviewOutcome(review, containmentRetryUsed = false) {
  if (review.contained && review.faithful && review.blended) return "accept";
  if (!review.contained && review.faithful && review.blended) {
    return containmentRetryUsed ? "reject-containment" : "retry-containment";
  }
  return "reject-reference";
}
