const STANDARD_EDIT_POLICY = Object.freeze({
  model: "gpt-image-2",
  background: null,
  inputFidelity: null,
});

const REFERENCE_EDIT_POLICY = Object.freeze({
  model: "gpt-image-1.5",
  background: "transparent",
  inputFidelity: "high",
});

/**
 * Match each edit request to provider capabilities. GPT Image 2 handles normal
 * canvas edits, while reference-object layers require a model that can return
 * transparency and honor explicit high input fidelity.
 */
export function imageEditProviderPolicy(hasReference) {
  return hasReference ? REFERENCE_EDIT_POLICY : STANDARD_EDIT_POLICY;
}
