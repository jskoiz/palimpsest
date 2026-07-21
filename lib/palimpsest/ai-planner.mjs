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
