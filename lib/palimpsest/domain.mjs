// @ts-check

export const ARTWORK_ID = "palimpsest-purple";
export const ARTWORK_SIZE = 2048;
export const GENERATION_FRAME_SIZE = 1024;
export const MIN_EDIT_EDGE = 64;
export const MAX_EDIT_EDGE = 512;
export const MAX_EDIT_PIXELS = MAX_EDIT_EDGE ** 2;
export const REFERENCE_IMAGE_MARGIN = 96;
export const REFERENCE_TARGET_FILL = 0.45;

export class DomainError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/** @param {unknown} value */
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Build the immutable display mask applied to a generated context layer.
 * Region coordinates are local to the 1024px generation frame. The mask is
 * deliberately binary: accepted pixels stop exactly at the contributor's
 * filled region or painted stroke, with no hidden inset or feathered edge.
 * @param {{
 *   region: {x: number, y: number, width: number, height: number},
 *   fill: boolean,
 *   strokes: Array<{width: number, points: Array<{x: number, y: number}>}>
 * }} mask
 */
export function createDisplayMaskSvg(mask) {
  const { x, y, width, height } = mask.region;
  /**
   * @param {{width: number, points: Array<{x: number, y: number}>}} stroke
   * @param {number} strokeWidth
   */
  const polyline = (stroke, strokeWidth) => {
    const points = stroke.points.map((point) => `${point.x + x},${point.y + y}`).join(" ");
    return `<polyline points="${points}" fill="none" stroke="white" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
  };
  const content = mask.fill
    ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="white" shape-rendering="crispEdges"/>`
    : mask.strokes.map((stroke) => polyline(stroke, stroke.width)).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${GENERATION_FRAME_SIZE}" height="${GENERATION_FRAME_SIZE}" viewBox="0 0 ${GENERATION_FRAME_SIZE} ${GENERATION_FRAME_SIZE}"><defs><clipPath id="edit-bounds"><rect x="${x}" y="${y}" width="${width}" height="${height}"/></clipPath></defs><g clip-path="url(#edit-bounds)">${content}</g></svg>`;
}

/**
 * Fit a reference inside a square input without cropping. Its maximum size is
 * derived from the selected edit region, so a large upload reaches the image
 * model at a scale that can actually fit inside the contributor's frame.
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {{width: number, height: number}} targetRegion
 * @param {number} [canvasSize]
 */
export function referenceImagePlacement(
  imageWidth,
  imageHeight,
  targetRegion,
  canvasSize = GENERATION_FRAME_SIZE,
) {
  const canvasAvailable = canvasSize - REFERENCE_IMAGE_MARGIN * 2;
  const availableWidth = Math.min(
    canvasAvailable,
    targetRegion.width * REFERENCE_TARGET_FILL,
  );
  const availableHeight = Math.min(
    canvasAvailable,
    targetRegion.height * REFERENCE_TARGET_FILL,
  );
  const scale = Math.min(
    availableWidth / imageWidth,
    availableHeight / imageHeight,
  );
  const width = Math.max(1, Math.round(imageWidth * scale));
  const height = Math.max(1, Math.round(imageHeight * scale));
  return {
    x: Math.round((canvasSize - width) / 2),
    y: Math.round((canvasSize - height) / 2),
    width,
    height,
  };
}

/**
 * Generated context frames always retain their reservation mask so pixels
 * outside the requested edit cannot replace the canonical artwork.
 * @param {string} origin
 * @param {string | null | undefined} maskBlobId
 */
export function displayMaskForLayer(origin, maskBlobId) {
  return origin === "openai" || origin === "demo" ? maskBlobId ?? null : null;
}

/**
 * @param {string} change
 * @param {boolean} [hasReference]
 */
export function buildOpenAiEditPrompt(change, hasReference = false) {
  return [
    hasReference
      ? "Create the requested subject on the blank transparent first image, only inside the transparent part of the mask. Leave every pixel outside the subject transparent."
      : "Edit the supplied image only inside the transparent part of the mask.",
    hasReference
      ? "Use the second supplied image as a direct visual reference for the requested change. Translate its relevant subject, composition, materials, or style into the editable area; do not paste its rectangular background unless the request asks for it."
      : "",
    hasReference
      ? "The second image has already been centered and scaled to the intended maximum footprint in the 1024px frame. Keep the generated subject at or below that prepared footprint; do not enlarge it."
      : "",
    hasReference
      ? "Return only the requested reference subject and its natural contact shadow as an isolated transparent PNG layer. The app composites this layer over the untouched source. Keep every non-subject pixel fully transparent; never render a rectangular background, matte, wash, halo, or frame."
      : "",
    hasReference
      ? "Preserve the reference subject's perspective, materials, proportions, lighting, texture, wear, and natural edge detail."
      : "Integrate the requested change naturally into the existing image by matching its local perspective, scale, lighting, texture, wear, and edge softness.",
    "If the request adds an object or character, show the entire subject comfortably inside the editable area with visible surrounding context and a clear margin on every side. Scale it down as needed so it occupies no more than 75% of the editable width or height and no visible part touches the mask boundary. Never crop, truncate, or press a new subject against the mask boundary.",
    "If a reference subject touches an edge of its source image, infer the missing extent instead of reproducing that crop; the placed subject must still be complete and fully contained.",
    "Honor the requested subject and style without forcing it into a predefined artistic motif.",
    hasReference
      ? "Do not redraw the source canvas; transparency outside the requested subject preserves it during compositing."
      : "Preserve the source outside the transparent mask.",
    `Requested change: ${change}`,
  ].filter(Boolean).join(" ");
}

/**
 * Validate the server-authoritative region and vector mask instructions.
 * Region coordinates are global within the 2048px artwork.
 * @param {any} input
 */
export function validateRegion(input) {
  if (!input || typeof input !== "object") {
    throw new DomainError("INVALID_REQUEST", "An edit region is required.");
  }

  if (
    Object.hasOwn(input, "tile") ||
    (input.region && typeof input.region === "object" && Object.hasOwn(input.region, "tile"))
  ) {
    throw new DomainError(
      "INVALID_REQUEST",
      "Edit regions use global artwork coordinates and must not include a tile.",
    );
  }

  const x = input.region?.x;
  const y = input.region?.y;
  const width = input.region?.width;
  const height = input.region?.height;

  if (![x, y, width, height].every(integer)) {
    throw new DomainError(
      "INVALID_REQUEST",
      "Region coordinates must be whole numbers.",
    );
  }
  if (
    width < MIN_EDIT_EDGE ||
    height < MIN_EDIT_EDGE ||
    width > MAX_EDIT_EDGE ||
    height > MAX_EDIT_EDGE
  ) {
    throw new DomainError(
      "REGION_OUT_OF_BOUNDS",
      "The editable patch must be between 64 and 512 pixels on each edge.",
    );
  }
  if (width * height > MAX_EDIT_PIXELS) {
    throw new DomainError(
      "MASK_TOO_LARGE",
      "The editable patch exceeds the maximum allowed area.",
    );
  }
  if (x < 0 || y < 0 || x + width > ARTWORK_SIZE || y + height > ARTWORK_SIZE) {
    throw new DomainError(
      "REGION_OUT_OF_BOUNDS",
      "The editable patch must stay inside the artwork.",
    );
  }

  const fill = input.fill === true;
  /** @type {Array<{width: any, points: any[]}>} */
  const strokes = Array.isArray(input.strokes) ? input.strokes : [];
  if (!fill && strokes.length === 0) {
    throw new DomainError("MASK_EMPTY", "Paint a mask before submitting the edit.");
  }
  if (strokes.length > 64) {
    throw new DomainError("INVALID_MASK", "The mask contains too many separate strokes.");
  }

  let totalPoints = 0;
  const normalizedStrokes = strokes.map((stroke) => {
    const brushWidth = stroke?.width;
    const points = Array.isArray(stroke?.points) ? stroke.points : [];
    if (!integer(brushWidth) || brushWidth < 4 || brushWidth > 64) {
      throw new DomainError("INVALID_MASK", "Brush width is outside the allowed range.");
    }
    if (points.length === 0 || points.length > 2048) {
      throw new DomainError("INVALID_MASK", "A mask stroke is empty or too detailed.");
    }
    totalPoints += points.length;
    return {
      width: brushWidth,
      points: points.map((point) => {
        const pointX = point?.x;
        const pointY = point?.y;
        if (!integer(pointX) || !integer(pointY)) {
          throw new DomainError("INVALID_MASK", "Mask points must use whole-number coordinates.");
        }
        if (pointX < 0 || pointY < 0 || pointX > width || pointY > height) {
          throw new DomainError(
            "REGION_OUT_OF_BOUNDS",
            "The mask must remain inside the assigned patch.",
          );
        }
        return { x: pointX, y: pointY };
      }),
    };
  });

  if (totalPoints > 8192) {
    throw new DomainError("INVALID_MASK", "The mask is too detailed to process safely.");
  }

  return {
    region: { x, y, width, height },
    fill,
    strokes: normalizedStrokes,
  };
}

/** @param {unknown} value */
export function normalizePrompt(value) {
  if (typeof value !== "string") {
    throw new DomainError("INVALID_REQUEST", "Describe the visual change you want to make.");
  }
  const prompt = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (prompt.length < 3 || prompt.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(prompt)) {
    throw new DomainError("INVALID_REQUEST", "The edit prompt must be between 3 and 500 characters.");
  }
  return prompt;
}

/** @param {unknown} value */
export function normalizeDisplayName(value) {
  const fallback = "Anonymous visitor";
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") {
    throw new DomainError("INVALID_REQUEST", "Display name must be text.");
  }
  const name = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 32) {
    throw new DomainError("INVALID_REQUEST", "Display name must be between 2 and 32 characters.");
  }
  if (!/^[\p{L}\p{N} .,'’\-]+$/u.test(name)) {
    throw new DomainError("INVALID_REQUEST", "Display name contains unsupported characters.");
  }
  return name;
}

/** @param {string} baseRevisionId @param {string} headRevisionId */
export function assertFreshBase(baseRevisionId, headRevisionId) {
  if (baseRevisionId !== headRevisionId) {
    throw new DomainError(
      "STALE_BASE_REVISION",
      "The artwork changed while you were editing. Review the latest revision before submitting again.",
    );
  }
  return true;
}

/** @param {any} row */
export function serializeRevision(row) {
  const region =
    row.regionX == null
      ? null
      : {
          x: Number(row.regionX),
          y: Number(row.regionY),
          width: Number(row.regionWidth),
          height: Number(row.regionHeight),
        };

  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    parentRevisionId: row.parentRevisionId ? String(row.parentRevisionId) : null,
    author: String(row.displayName),
    prompt: String(row.prompt),
    createdAt: new Date(Number(row.createdAt)).toISOString(),
    origin: String(row.origin),
    status: "accepted",
    region,
    revertTargetRevisionId: row.revertTargetRevisionId
      ? String(row.revertTargetRevisionId)
      : null,
    provenance:
      row.origin === "seed"
        ? "Archive seed"
        : row.origin === "demo"
          ? "Demo render"
          : row.origin === "openai"
            ? "OpenAI image edit"
            : "Restored as a new revision",
    sharePath: `/?revision=${encodeURIComponent(String(row.id))}`,
  };
}

/** @param {any[]} rows */
export function serializeHistory(rows) {
  return [...rows]
    .sort((a, b) => Number(a.sequence) - Number(b.sequence))
    .map(serializeRevision);
}

/**
 * Resolve the ordered global layer stack at the last supplied revision. A
 * revert resets the visible stack to its target revision, then later layers
 * continue from that restored state.
 * @param {any[]} revisions
 * @param {any[]} layers
 */
export function resolveLayerStack(revisions, layers) {
  const layersByRevision = new Map();
  for (const layer of layers) {
    const group = layersByRevision.get(layer.revisionId) ?? [];
    group.push(layer);
    layersByRevision.set(layer.revisionId, group);
  }

  /** @type {any[]} */
  let current = [];
  const snapshots = new Map();
  for (const revision of [...revisions].sort(
    (a, b) => Number(a.sequence) - Number(b.sequence),
  )) {
    if (revision.origin === "revert" && revision.revertTargetRevisionId) {
      const target = snapshots.get(revision.revertTargetRevisionId);
      if (!target) {
        throw new DomainError("INTERNAL_ERROR", "A revert target could not be resolved.");
      }
      current = [...target];
    } else {
      current = [...current];
    }

    current.push(...(layersByRevision.get(revision.id) ?? []));
    snapshots.set(revision.id, [...current]);
  }

  return current;
}

/** @param {string} value */
export function escapeXml(value) {
  return value.replace(/[<>&"']/g, (character) => {
    /** @type {Record<string, string>} */
    const replacements = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return replacements[character];
  });
}
