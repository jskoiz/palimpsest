const TILE_SIZE = 1024;
const TILE_COUNT = 2;

/**
 * @typedef {{
 *   tile: {x: number, y: number},
 *   region: {x: number, y: number, width: number, height: number}
 * }} EditRegion
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

function positionAxis(desiredGlobalStart, size, preferredTile) {
  const localMaximum = TILE_SIZE - size;
  const desired = Math.round(desiredGlobalStart);
  const candidates = Array.from({ length: TILE_COUNT }, (_, tile) => {
    const local = clamp(desired - tile * TILE_SIZE, 0, localMaximum);
    const global = tile * TILE_SIZE + local;
    return { tile, local, distance: Math.abs(global - desired) };
  });
  candidates.sort((left, right) => {
    const distance = left.distance - right.distance;
    if (distance !== 0) return distance;
    if (left.tile === preferredTile) return -1;
    if (right.tile === preferredTile) return 1;
    return left.tile - right.tile;
  });
  return candidates[0];
}

/**
 * Position a fixed-size patch from a desired global top-left coordinate.
 * The result always remains fully inside one of the four storage tiles.
 *
 * @param {EditRegion} current
 * @param {number} desiredGlobalX
 * @param {number} desiredGlobalY
 * @returns {EditRegion}
 */
export function positionEditRegion(current, desiredGlobalX, desiredGlobalY) {
  const horizontal = positionAxis(
    desiredGlobalX,
    current.region.width,
    current.tile.x,
  );
  const vertical = positionAxis(
    desiredGlobalY,
    current.region.height,
    current.tile.y,
  );
  return {
    tile: { x: horizontal.tile, y: vertical.tile },
    region: {
      x: horizontal.local,
      y: vertical.local,
      width: current.region.width,
      height: current.region.height,
    },
  };
}

function nudgeAxis(tile, local, size, delta) {
  const localMaximum = TILE_SIZE - size;
  const next = local + delta;
  if (next > localMaximum && tile < TILE_COUNT - 1) {
    return { tile: tile + 1, local: 0 };
  }
  if (next < 0 && tile > 0) {
    return { tile: tile - 1, local: localMaximum };
  }
  return { tile, local: clamp(next, 0, localMaximum) };
}

/**
 * Nudge a patch with explicit seam crossing for keyboard navigation.
 *
 * @param {EditRegion} current
 * @param {number} deltaX
 * @param {number} deltaY
 * @returns {EditRegion}
 */
export function nudgeEditRegion(current, deltaX, deltaY) {
  const horizontal = nudgeAxis(
    current.tile.x,
    current.region.x,
    current.region.width,
    deltaX,
  );
  const vertical = nudgeAxis(
    current.tile.y,
    current.region.y,
    current.region.height,
    deltaY,
  );
  return {
    tile: { x: horizontal.tile, y: vertical.tile },
    region: {
      x: horizontal.local,
      y: vertical.local,
      width: current.region.width,
      height: current.region.height,
    },
  };
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
