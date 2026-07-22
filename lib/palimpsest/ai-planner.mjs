export const EDIT_PLANNER_MODEL = "gpt-5.6";

const EDIT_PLANNER_INSTRUCTIONS = `You plan one localized image edit for a shared artwork.
Rewrite the contributor's request as a concise visual instruction for an image-editing model.
Preserve the contributor's intent and requested details exactly.
Do not invent new subjects, text, symbolism, composition, or an art style.
Describe only the requested change and how it should sit naturally inside the masked area.
Return one to three plain sentences with no heading, preamble, markdown, or alternatives.`;

export function buildEditPlanRequest(prompt, hasReference = false) {
  return {
    model: EDIT_PLANNER_MODEL,
    reasoning: { effort: "low" },
    instructions: EDIT_PLANNER_INSTRUCTIONS,
    input: [
      `Contributor request: ${prompt}`,
      hasReference
        ? "A second image will be supplied as a visual reference for the requested subject or treatment."
        : "No separate reference image will be supplied.",
    ].join("\n"),
    max_output_tokens: 180,
    store: false,
    text: { verbosity: "low" },
  };
}

export function extractEditPlan(responseBody) {
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

  const plan = fragments.join("\n").trim();
  return plan || null;
}

const CONTAINMENT_REVIEW_INSTRUCTIONS = `Inspect a generated localized image edit before it is accepted.
Judge only the newly requested subject inside the transparent editable area shown by the second image.
If the request adds a discrete object or character, it must be complete, uncropped, and surrounded by clear space on every side inside that area.
Any requested subject touching or crossing the editable boundary fails.
If the request is only a texture, lighting, background, or style treatment with no discrete subject, it passes.
Ignore unrelated pre-existing content outside the editable area.`;

export function buildContainmentReviewRequest({
  requestedChange,
  generatedImageUrl,
  providerMaskUrl,
}) {
  return {
    model: EDIT_PLANNER_MODEL,
    reasoning: { effort: "low" },
    instructions: CONTAINMENT_REVIEW_INSTRUCTIONS,
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text: `Requested change: ${requestedChange}\nFirst image: generated result. Second image: black protected pixels with a transparent editable area. Return whether every requested subject is complete with clear space on every side.`,
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
        name: "subject_containment",
        strict: true,
        schema: {
          type: "object",
          properties: {
            contained: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["contained", "reason"],
          additionalProperties: false,
        },
      },
    },
  };
}

export function extractContainmentReview(responseBody) {
  const text = extractEditPlan(responseBody);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (
      typeof parsed?.contained !== "boolean" ||
      typeof parsed?.reason !== "string"
    ) {
      return null;
    }
    return { contained: parsed.contained, reason: parsed.reason.trim() };
  } catch {
    return null;
  }
}
