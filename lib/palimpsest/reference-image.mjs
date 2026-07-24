// @ts-check

const VISIBLE_ALPHA_THRESHOLD = 8;

/**
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 */
function visibleBounds(data, width, height) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= VISIBLE_ALPHA_THRESHOLD) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return null;
  return {
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

/**
 * Prepare browser-decoded RGBA pixels for exact canvas placement.
 *
 * Uploaded pixels are authoritative and remain byte-exact. Existing transparent
 * padding is trimmed, while opaque uploads retain their complete rectangular
 * frame. Background isolation belongs to the generation prompt so pale,
 * reflective, frosted, and translucent subject details are never destroyed.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} input
 */
export function prepareReferencePixels(input) {
  const { data, width, height } = input;
  if (
    !(data instanceof Uint8ClampedArray) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    data.length !== width * height * 4
  ) {
    throw new Error("Reference pixels must be a non-empty RGBA image.");
  }

  const original = new Uint8ClampedArray(data);
  const bounds = visibleBounds(original, width, height);
  if (!bounds) throw new Error("That reference image has no visible pixels.");
  return {
    data: original,
    bounds,
  };
}
