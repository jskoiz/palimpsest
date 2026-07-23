import {
  ARTWORK_SIZE,
  GENERATION_FRAME_SIZE,
  MAX_EDIT_EDGE,
  MIN_EDIT_EDGE,
  REFERENCE_EDIT_MIN_EDGE,
} from "./domain.mjs";

export { GENERATION_FRAME_SIZE };
export const EDIT_REGION_MIN_EDGE = 160;
export const EDIT_REGION_MAX_EDGE = MAX_EDIT_EDGE;
export const GENERATION_REGION_TARGET_FILL = 0.625;
export const GENERATION_FRAME_MIN_EDGE = 256;
const REFERENCE_REGION_SIZE_STEP = 32;

/**
 * @typedef {{x: number, y: number, width: number, height: number}} Rectangle
 */

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteNonNegative(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Return the translation limits for the square cover canvas at a given zoom.
 * The cover is centered in the viewport before the outer zoom transform runs.
 *
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @param {number} zoom
 */
export function canvasPanBounds(viewportWidth, viewportHeight, zoom) {
  const width = finiteNonNegative(viewportWidth);
  const height = finiteNonNegative(viewportHeight);
  const scale = Number.isFinite(zoom) ? Math.max(1, zoom) : 1;
  const canvasSize = Math.max(width, height);
  return {
    minX: width - (scale * (width + canvasSize)) / 2,
    maxX: (scale * (canvasSize - width)) / 2,
    minY: height - (scale * (height + canvasSize)) / 2,
    maxY: (scale * (canvasSize - height)) / 2,
  };
}

/**
 * Keep a zoomed or cover-cropped canvas inside the viewport without revealing
 * empty space around it.
 *
 * @param {{zoom: number, x: number, y: number}} view
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 */
export function constrainCanvasView(view, viewportWidth, viewportHeight) {
  const zoom = Number.isFinite(view.zoom) ? Math.max(1, view.zoom) : 1;
  const bounds = canvasPanBounds(viewportWidth, viewportHeight, zoom);
  const x = Number.isFinite(view.x) ? view.x : 0;
  const y = Number.isFinite(view.y) ? view.y : 0;
  return {
    zoom,
    x: clamp(x, bounds.minX, bounds.maxX),
    y: clamp(y, bounds.minY, bounds.maxY),
  };
}

/**
 * Whether the square canvas has content outside either viewport axis.
 *
 * @param {{zoom: number}} view
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 */
export function canvasViewCanPan(view, viewportWidth, viewportHeight) {
  if (viewportWidth <= 0 || viewportHeight <= 0) return false;
  const bounds = canvasPanBounds(viewportWidth, viewportHeight, view.zoom);
  return bounds.minX < bounds.maxX || bounds.minY < bounds.maxY;
}

function positionAxis(desiredGlobalStart, size) {
  return clamp(Math.round(desiredGlobalStart), 0, ARTWORK_SIZE - size);
}

/**
 * Position a fixed-size patch from a desired global top-left coordinate.
 * The patch remains inside the artwork but may cross either 1024px seam.
 *
 * @param {Rectangle} current
 * @param {number} desiredGlobalX
 * @param {number} desiredGlobalY
 * @returns {Rectangle}
 */
export function positionEditRegion(current, desiredGlobalX, desiredGlobalY) {
  return {
    x: positionAxis(desiredGlobalX, current.width),
    y: positionAxis(desiredGlobalY, current.height),
    width: current.width,
    height: current.height,
  };
}

/**
 * Nudge a patch continuously through artwork space for keyboard navigation.
 *
 * @param {Rectangle} current
 * @param {number} deltaX
 * @param {number} deltaY
 * @returns {Rectangle}
 */
export function nudgeEditRegion(current, deltaX, deltaY) {
  return {
    x: clamp(current.x + deltaX, 0, ARTWORK_SIZE - current.width),
    y: clamp(current.y + deltaY, 0, ARTWORK_SIZE - current.height),
    width: current.width,
    height: current.height,
  };
}

/**
 * Resize a patch from its lower-right corner while keeping the opposite corner
 * fixed. The interactive patch stays comfortably usable and cannot grow past
 * one quarter of the artwork on either edge.
 *
 * @param {Rectangle} current
 * @param {number} desiredWidth
 * @param {number} desiredHeight
 * @param {number} [minimumEdge]
 * @param {number} [maximumEdge]
 * @returns {Rectangle}
 */
export function resizeEditRegion(
  current,
  desiredWidth,
  desiredHeight,
  minimumEdge = EDIT_REGION_MIN_EDGE,
  maximumEdge = EDIT_REGION_MAX_EDGE,
) {
  const minimum = clamp(Math.round(minimumEdge), MIN_EDIT_EDGE, MAX_EDIT_EDGE);
  const maximum = clamp(Math.round(maximumEdge), minimum, MAX_EDIT_EDGE);
  const availableWidth = ARTWORK_SIZE - current.x;
  const availableHeight = ARTWORK_SIZE - current.y;
  return {
    x: current.x,
    y: current.y,
    width: clamp(Math.round(desiredWidth), minimum, Math.min(maximum, availableWidth)),
    height: clamp(Math.round(desiredHeight), minimum, Math.min(maximum, availableHeight)),
  };
}

/**
 * Expand a selected patch around its center for a reference-guided edit.
 * The short edge is never smaller than the reference minimum. The long edge
 * follows the uploaded image's aspect ratio in 32px steps, up to the normal
 * patch maximum, without shrinking a larger user selection.
 *
 * @param {Rectangle} current
 * @param {number} referenceAspectRatio
 * @returns {Rectangle}
 */
export function referenceSafeEditRegion(current, referenceAspectRatio) {
  const aspectRatio =
    Number.isFinite(referenceAspectRatio) && referenceAspectRatio > 0
      ? referenceAspectRatio
      : 1;
  let referenceWidth = REFERENCE_EDIT_MIN_EDGE;
  let referenceHeight = REFERENCE_EDIT_MIN_EDGE;
  if (aspectRatio > 1) {
    referenceWidth = Math.min(
      EDIT_REGION_MAX_EDGE,
      Math.ceil(
        (REFERENCE_EDIT_MIN_EDGE * aspectRatio) / REFERENCE_REGION_SIZE_STEP,
      ) * REFERENCE_REGION_SIZE_STEP,
    );
  } else if (aspectRatio < 1) {
    referenceHeight = Math.min(
      EDIT_REGION_MAX_EDGE,
      Math.ceil(
        (REFERENCE_EDIT_MIN_EDGE / aspectRatio) / REFERENCE_REGION_SIZE_STEP,
      ) * REFERENCE_REGION_SIZE_STEP,
    );
  }

  const width = Math.max(current.width, referenceWidth);
  const height = Math.max(current.height, referenceHeight);
  const centered = {
    x: Math.round(current.x + current.width / 2 - width / 2),
    y: Math.round(current.y + current.height / 2 - height / 2),
    width,
    height,
  };
  return positionEditRegion(centered, centered.x, centered.y);
}

/**
 * Place an adaptive square generation context around a global edit region.
 * Small contributions occupy enough of the model's 1024px working image to
 * preserve text, framing, and reference detail. The frame remains centered
 * even at artwork edges; callers extend the nearest canvas pixels into any
 * virtual context that falls outside the artwork.
 *
 * @param {Rectangle} region
 * @returns {Rectangle}
 */
export function generationFrameForRegion(region) {
  const edge = clamp(
    Math.ceil(Math.max(region.width, region.height) / GENERATION_REGION_TARGET_FILL),
    GENERATION_FRAME_MIN_EDGE,
    GENERATION_FRAME_SIZE,
  );
  return {
    x: Math.round(region.x + region.width / 2 - edge / 2),
    y: Math.round(region.y + region.height / 2 - edge / 2),
    width: edge,
    height: edge,
  };
}

/**
 * Map a global edit region into the model's fixed 1024px working image.
 * Boundaries are mapped independently so rounding cannot create gaps.
 *
 * @param {Rectangle} region
 * @param {Rectangle} [frame]
 * @returns {Rectangle}
 */
export function regionInGenerationFrame(region, frame = generationFrameForRegion(region)) {
  const scaleX = GENERATION_FRAME_SIZE / frame.width;
  const scaleY = GENERATION_FRAME_SIZE / frame.height;
  const left = Math.round((region.x - frame.x) * scaleX);
  const top = Math.round((region.y - frame.y) * scaleY);
  const right = Math.round((region.x + region.width - frame.x) * scaleX);
  const bottom = Math.round((region.y + region.height - frame.y) * scaleY);
  return {
    x: clamp(left, 0, GENERATION_FRAME_SIZE),
    y: clamp(top, 0, GENERATION_FRAME_SIZE),
    width: clamp(right - left, 1, GENERATION_FRAME_SIZE),
    height: clamp(bottom - top, 1, GENERATION_FRAME_SIZE),
  };
}

/**
 * Scale contributor brush strokes into the same provider-pixel coordinates as
 * the mapped edit region.
 *
 * @param {Rectangle} region
 * @param {Array<{width: number, points: Array<{x: number, y: number}>}>} strokes
 * @param {Rectangle} [frame]
 */
export function maskInGenerationFrame(
  region,
  strokes,
  frame = generationFrameForRegion(region),
) {
  const mappedRegion = regionInGenerationFrame(region, frame);
  const scaleX = mappedRegion.width / region.width;
  const scaleY = mappedRegion.height / region.height;
  const brushScale = Math.min(scaleX, scaleY);
  return {
    region: mappedRegion,
    strokes: strokes.map((stroke) => ({
      width: Math.max(1, Math.round(stroke.width * brushScale)),
      points: stroke.points.map((point) => ({
        x: clamp(Math.round(point.x * scaleX), 0, mappedRegion.width),
        y: clamp(Math.round(point.y * scaleY), 0, mappedRegion.height),
      })),
    })),
  };
}

/**
 * Whether two rectangles share positive-area intersection. Touching only at
 * an edge or corner is not overlap.
 *
 * @param {Rectangle} a
 * @param {Rectangle} b
 */
export function regionsOverlap(a, b) {
  if (
    a.width <= 0 ||
    a.height <= 0 ||
    b.width <= 0 ||
    b.height <= 0
  ) {
    return false;
  }
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Resolve a horizontal timeline pointer position to the nearest revision.
 * Values outside the track clamp to the first or last revision.
 *
 * @param {number} pointerX
 * @param {number} trackLeft
 * @param {number} trackWidth
 * @param {number} revisionCount
 * @returns {number}
 */
export function timelineIndexAtPosition(
  pointerX,
  trackLeft,
  trackWidth,
  revisionCount,
) {
  const lastIndex = Math.max(0, Math.floor(revisionCount) - 1);
  if (
    lastIndex === 0 ||
    !Number.isFinite(pointerX) ||
    !Number.isFinite(trackLeft) ||
    !Number.isFinite(trackWidth) ||
    trackWidth <= 0
  ) {
    return 0;
  }
  const progress = clamp((pointerX - trackLeft) / trackWidth, 0, 1);
  return Math.round(progress * lastIndex);
}
