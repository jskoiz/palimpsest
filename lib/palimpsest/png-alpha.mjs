const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const RGBA_BYTES_PER_PIXEL = 4;
const MAX_PIXELS = 4096 * 4096;

function readUint32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function concatBytes(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function paethPredictor(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

async function decodeRgbaPng(bytes) {
  if (
    bytes.byteLength < 33 ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
  ) {
    throw new Error("The generated layer is not a valid PNG.");
  }

  let width = 0;
  let height = 0;
  let offset = PNG_SIGNATURE.length;
  const compressedChunks = [];
  while (offset + 12 <= bytes.byteLength) {
    const length = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const nextOffset = dataOffset + length + 4;
    if (nextOffset > bytes.byteLength) {
      throw new Error("The generated layer contains a truncated PNG chunk.");
    }
    const type = String.fromCharCode(...bytes.subarray(typeOffset, typeOffset + 4));
    const data = bytes.subarray(dataOffset, dataOffset + length);
    if (type === "IHDR") {
      if (length !== 13) throw new Error("The generated layer has an invalid PNG header.");
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      const bitDepth = data[8];
      const colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (
        bitDepth !== 8 ||
        colorType !== 6 ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        throw new Error("The generated layer must be a non-interlaced 8-bit RGBA PNG.");
      }
      if (width < 1 || height < 1 || width * height > MAX_PIXELS) {
        throw new Error("The generated layer has unsafe PNG dimensions.");
      }
    } else if (type === "IDAT") {
      compressedChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = nextOffset;
  }

  if (!width || !height || compressedChunks.length === 0) {
    throw new Error("The generated layer is missing required PNG data.");
  }

  const compressed = concatBytes(compressedChunks);
  const inflatedStream = new Blob([Uint8Array.from(compressed)])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  const stride = width * RGBA_BYTES_PER_PIXEL;
  const expectedFilteredSize = (stride + 1) * height;
  const filtered = new Uint8Array(expectedFilteredSize);
  const reader = inflatedStream.getReader();
  let filteredOffset = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (filteredOffset + value.byteLength > expectedFilteredSize) {
      await reader.cancel();
      throw new Error("The generated layer expands beyond its declared PNG dimensions.");
    }
    filtered.set(value, filteredOffset);
    filteredOffset += value.byteLength;
  }
  if (filteredOffset !== expectedFilteredSize) {
    throw new Error("The generated layer has an invalid PNG scanline length.");
  }

  const rgba = new Uint8Array(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = filtered[sourceOffset];
    sourceOffset += 1;
    if (filterType > 4) throw new Error("The generated layer uses an invalid PNG filter.");
    const rowOffset = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[sourceOffset];
      sourceOffset += 1;
      const left = x >= RGBA_BYTES_PER_PIXEL
        ? rgba[rowOffset + x - RGBA_BYTES_PER_PIXEL]
        : 0;
      const above = y > 0 ? rgba[rowOffset + x - stride] : 0;
      const upperLeft = y > 0 && x >= RGBA_BYTES_PER_PIXEL
        ? rgba[rowOffset + x - stride - RGBA_BYTES_PER_PIXEL]
        : 0;
      const predictor =
        filterType === 0 ? 0
          : filterType === 1 ? left
            : filterType === 2 ? above
              : filterType === 3 ? Math.floor((left + above) / 2)
                : paethPredictor(left, above, upperLeft);
      rgba[rowOffset + x] = (raw + predictor) & 0xff;
    }
  }

  return { width, height, rgba };
}

/**
 * Inspect the actual PNG alpha channel. This rejects patches whose visible
 * pixels reach the editable boundary or form a solid rectangular matte; it
 * never changes or feathers the generated pixels.
 */
export async function inspectPngAlphaPlacement(bytes, region, options = {}) {
  const decoded = await decodeRgbaPng(bytes);
  const values = [region?.x, region?.y, region?.width, region?.height];
  if (
    !values.every(Number.isSafeInteger) ||
    region.width < 1 ||
    region.height < 1 ||
    region.x < 0 ||
    region.y < 0 ||
    region.x + region.width > decoded.width ||
    region.y + region.height > decoded.height
  ) {
    throw new Error("The editable region is outside the generated PNG.");
  }

  const alphaThreshold = Number.isSafeInteger(options.alphaThreshold)
    ? Math.max(0, Math.min(254, options.alphaThreshold))
    : 8;
  const defaultMargin = Math.max(8, Math.floor(Math.min(region.width, region.height) * 0.04));
  const marginPixels = Number.isSafeInteger(options.marginPixels)
    ? Math.max(0, options.marginPixels)
    : defaultMargin;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let visiblePixels = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const alpha = decoded.rgba[(y * decoded.width + x) * RGBA_BYTES_PER_PIXEL + 3];
      if (alpha <= alphaThreshold) continue;
      visiblePixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (visiblePixels === 0) {
    return {
      backgroundClear: false,
      bounds: null,
      visiblePixels: 0,
      fillRatio: 0,
      touchesBoundary: false,
      rectangularFill: false,
    };
  }

  const bounds = {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
  const touchesBoundary =
    minX < region.x + marginPixels ||
    minY < region.y + marginPixels ||
    maxX > region.x + region.width - 1 - marginPixels ||
    maxY > region.y + region.height - 1 - marginPixels;
  const fillRatio = visiblePixels / (bounds.width * bounds.height);
  const rectangularFill = bounds.width >= 4 && bounds.height >= 4 && fillRatio >= 0.985;

  return {
    backgroundClear: !touchesBoundary && !rectangularFill,
    bounds,
    visiblePixels,
    fillRatio,
    touchesBoundary,
    rectangularFill,
  };
}
