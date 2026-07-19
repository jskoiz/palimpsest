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
