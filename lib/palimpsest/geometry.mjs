import {
  ARTWORK_SIZE,
  GENERATION_FRAME_SIZE,
  MAX_EDIT_EDGE,
  MIN_EDIT_EDGE,
} from "./domain.mjs";

export { GENERATION_FRAME_SIZE };
export const EDIT_REGION_MIN_EDGE = 160;
export const EDIT_REGION_MAX_EDGE = MAX_EDIT_EDGE;

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
 * Place a fixed-size generation context around a global edit region. The
 * region is centered when possible and the frame clamps at artwork edges.
 *
 * @param {Rectangle} region
 * @returns {Rectangle}
 */
export function generationFrameForRegion(region) {
  const frameMaximum = ARTWORK_SIZE - GENERATION_FRAME_SIZE;
  return {
    x: clamp(
      Math.round(region.x + region.width / 2 - GENERATION_FRAME_SIZE / 2),
      0,
      frameMaximum,
    ),
    y: clamp(
      Math.round(region.y + region.height / 2 - GENERATION_FRAME_SIZE / 2),
      0,
      frameMaximum,
    ),
    width: GENERATION_FRAME_SIZE,
    height: GENERATION_FRAME_SIZE,
  };
}

/**
 * Express a global edit region in the local coordinate space of its context
 * frame. The result can be passed directly to createDisplayMaskSvg.
 *
 * @param {Rectangle} region
 * @param {Rectangle} [frame]
 * @returns {Rectangle}
 */
export function regionRelativeToFrame(region, frame = generationFrameForRegion(region)) {
  return {
    x: region.x - frame.x,
    y: region.y - frame.y,
    width: region.width,
    height: region.height,
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
