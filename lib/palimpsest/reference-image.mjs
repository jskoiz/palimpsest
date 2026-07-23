// @ts-check

const BACKGROUND_QUANTIZATION_SHIFT = 4;
const BACKGROUND_SOFT_DISTANCE = 24;
const BACKGROUND_MAX_DISTANCE = 92;
const MIN_REMOVED_FRACTION = 0.03;
const MAX_REMOVED_FRACTION = 0.96;
const MIN_EXISTING_TRANSPARENCY_FRACTION = 0.005;
const MIN_EXISTING_TRANSPARENT_PIXELS = 16;
const VISIBLE_ALPHA_THRESHOLD = 8;

/** @param {number} value */
function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** @param {Uint8ClampedArray} data @param {number} offset */
function quantizedColor(data, offset) {
  return (
    (data[offset] >> BACKGROUND_QUANTIZATION_SHIFT) << 8 |
    (data[offset + 1] >> BACKGROUND_QUANTIZATION_SHIFT) << 4 |
    (data[offset + 2] >> BACKGROUND_QUANTIZATION_SHIFT)
  );
}

/**
 * Estimate the dominant edge-connected background color. Border sampling keeps
 * the operation deterministic and avoids treating an enclosed dark detail as
 * background merely because it is common inside the subject.
 *
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 */
function dominantBorderColor(data, width, height) {
  /** @type {Map<number, {count: number, red: number, green: number, blue: number}>} */
  const buckets = new Map();
  /** @param {number} pixelIndex */
  const sample = (pixelIndex) => {
    const offset = pixelIndex * 4;
    if (data[offset + 3] < 250) return;
    const key = quantizedColor(data, offset);
    const current = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
    current.count += 1;
    current.red += data[offset];
    current.green += data[offset + 1];
    current.blue += data[offset + 2];
    buckets.set(key, current);
  };

  for (let x = 0; x < width; x += 1) {
    sample(x);
    if (height > 1) sample((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(y * width);
    if (width > 1) sample(y * width + width - 1);
  }

  let dominant = null;
  for (const bucket of buckets.values()) {
    if (!dominant || bucket.count > dominant.count) dominant = bucket;
  }
  if (!dominant) return null;
  return {
    red: dominant.red / dominant.count,
    green: dominant.green / dominant.count,
    blue: dominant.blue / dominant.count,
  };
}

/**
 * @param {Uint8ClampedArray} data
 * @param {number} offset
 * @param {{red: number, green: number, blue: number}} background
 */
function colorDistance(data, offset, background) {
  const red = data[offset] - background.red;
  const green = data[offset + 1] - background.green;
  const blue = data[offset + 2] - background.blue;
  return Math.sqrt(red * red + green * green + blue * blue);
}

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
 * Existing transparency is authoritative and is never regenerated. Fully
 * opaque uploads receive a deterministic border-connected background removal:
 * only pixels connected to the image edge and close to the dominant border
 * color are made transparent. Enclosed details with the same color survive.
 * The returned bounds are the exact visible subject bounds used by both the
 * preview and committed placement.
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
  let transparentPixels = 0;
  let missingAlpha = 0;
  for (let offset = 3; offset < original.length; offset += 4) {
    if (original[offset] < 250) {
      transparentPixels += 1;
      missingAlpha += 255 - original[offset];
    }
  }
  const hasMeaningfulTransparency =
    transparentPixels >= Math.min(MIN_EXISTING_TRANSPARENT_PIXELS, width * height) &&
    missingAlpha / (width * height * 255) >= MIN_EXISTING_TRANSPARENCY_FRACTION;
  if (hasMeaningfulTransparency) {
    const bounds = visibleBounds(original, width, height);
    if (!bounds) throw new Error("That reference image has no visible pixels.");
    return {
      data: original,
      bounds,
      backgroundRemoved: false,
      removedFraction: 0,
    };
  }

  const background = dominantBorderColor(original, width, height);
  if (!background) {
    const bounds = visibleBounds(original, width, height);
    if (!bounds) throw new Error("That reference image has no visible pixels.");
    return {
      data: original,
      bounds,
      backgroundRemoved: false,
      removedFraction: 0,
    };
  }

  const pixelCount = width * height;
  const connected = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let queueStart = 0;
  let queueEnd = 0;
  /** @param {number} pixelIndex */
  const enqueue = (pixelIndex) => {
    if (connected[pixelIndex]) return;
    const offset = pixelIndex * 4;
    if (colorDistance(original, offset, background) > BACKGROUND_MAX_DISTANCE) return;
    connected[pixelIndex] = 1;
    queue[queueEnd] = pixelIndex;
    queueEnd += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    if (height > 1) enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    if (width > 1) enqueue(y * width + width - 1);
  }

  while (queueStart < queueEnd) {
    const pixelIndex = queue[queueStart];
    queueStart += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (x > 0) enqueue(pixelIndex - 1);
    if (x + 1 < width) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - width);
    if (y + 1 < height) enqueue(pixelIndex + width);
  }

  const processed = new Uint8ClampedArray(original);
  let removedAlpha = 0;
  let visiblePixels = 0;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    if (connected[pixelIndex]) {
      const distance = colorDistance(original, offset, background);
      const alphaFraction = Math.max(
        0,
        Math.min(
          1,
          (distance - BACKGROUND_SOFT_DISTANCE) /
            (BACKGROUND_MAX_DISTANCE - BACKGROUND_SOFT_DISTANCE),
        ),
      );
      const nextAlpha = clampByte(original[offset + 3] * alphaFraction);
      removedAlpha += original[offset + 3] - nextAlpha;
      processed[offset + 3] = nextAlpha;
      if (nextAlpha > 0 && alphaFraction > 0) {
        processed[offset] = clampByte(
          (original[offset] - background.red * (1 - alphaFraction)) / alphaFraction,
        );
        processed[offset + 1] = clampByte(
          (original[offset + 1] - background.green * (1 - alphaFraction)) /
            alphaFraction,
        );
        processed[offset + 2] = clampByte(
          (original[offset + 2] - background.blue * (1 - alphaFraction)) /
            alphaFraction,
        );
      }
    }
    if (processed[offset + 3] > VISIBLE_ALPHA_THRESHOLD) visiblePixels += 1;
  }

  const removedFraction = removedAlpha / (pixelCount * 255);
  const removalIsUseful =
    removedFraction >= MIN_REMOVED_FRACTION &&
    removedFraction <= MAX_REMOVED_FRACTION &&
    visiblePixels >= Math.max(16, Math.ceil(pixelCount * 0.01));
  const selected = removalIsUseful ? processed : original;
  const bounds = visibleBounds(selected, width, height);
  if (!bounds) throw new Error("That reference image has no visible pixels.");
  return {
    data: selected,
    bounds,
    backgroundRemoved: removalIsUseful,
    removedFraction: removalIsUseful ? removedFraction : 0,
  };
}
