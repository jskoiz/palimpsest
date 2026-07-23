// @ts-check

import { DomainError } from "./domain.mjs";

export const REFERENCE_PNG_WIDTH = 1024;
export const REFERENCE_PNG_HEIGHT = 1024;
export const MAX_REFERENCE_PNG_BYTES = 6 * 1024 * 1024;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const RGBA_BYTES_PER_PIXEL = 4;
const MAX_PNG_CHUNKS = 4096;
const EXPECTED_SCANLINE_BYTES =
  1 + REFERENCE_PNG_WIDTH * RGBA_BYTES_PER_PIXEL;
const EXPECTED_INFLATED_BYTES =
  REFERENCE_PNG_HEIGHT * EXPECTED_SCANLINE_BYTES;

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0
      ? 0xedb88320 ^ (value >>> 1)
      : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

/**
 * @param {string} message
 * @returns {never}
 */
function invalidReferencePng(message) {
  throw new DomainError("INVALID_REQUEST", message);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function readUint32(bytes, offset) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    4,
  ).getUint32(0);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 */
function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc = CRC_TABLE[(crc ^ bytes[offset]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {number} value */
function isAsciiLetter(value) {
  return (
    (value >= 65 && value <= 90) ||
    (value >= 97 && value <= 122)
  );
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function chunkType(bytes, offset) {
  const typeBytes = bytes.subarray(offset, offset + 4);
  if (
    typeBytes.length !== 4 ||
    ![...typeBytes].every(isAsciiLetter) ||
    (typeBytes[2] & 0x20) !== 0
  ) {
    invalidReferencePng("The reference image contains an invalid PNG chunk.");
  }
  return String.fromCharCode(...typeBytes);
}

/**
 * @param {Array<Uint8Array>} chunks
 * @param {number} byteLength
 * @returns {Promise<Uint8Array>}
 */
async function inflateIdat(chunks, byteLength) {
  if (
    byteLength < 1 ||
    byteLength > MAX_REFERENCE_PNG_BYTES
  ) {
    invalidReferencePng("The reference image has invalid compressed pixel data.");
  }

  const compressed = new Uint8Array(byteLength);
  let compressedOffset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, compressedOffset);
    compressedOffset += chunk.byteLength;
  }

  try {
    const source = new Blob([compressed.buffer]).stream();
    const reader = source
      .pipeThrough(new DecompressionStream("deflate"))
      .getReader();
    const inflated = new Uint8Array(EXPECTED_INFLATED_BYTES);
    let inflatedOffset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (
        !(value instanceof Uint8Array) ||
        inflatedOffset + value.byteLength > inflated.byteLength
      ) {
        await reader.cancel().catch(() => undefined);
        invalidReferencePng("The reference image expands beyond its declared frame.");
      }
      inflated.set(value, inflatedOffset);
      inflatedOffset += value.byteLength;
    }
    if (inflatedOffset !== inflated.byteLength) {
      invalidReferencePng("The reference image has incomplete pixel data.");
    }
    return inflated;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    invalidReferencePng("The reference image has invalid compressed pixel data.");
  }
}

/**
 * @param {number} left
 * @param {number} up
 * @param {number} upperLeft
 */
function paeth(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

/** @param {Uint8Array} inflated */
function validateScanlines(inflated) {
  const rowBytes = REFERENCE_PNG_WIDTH * RGBA_BYTES_PER_PIXEL;
  let previous = new Uint8Array(rowBytes);
  let current = new Uint8Array(rowBytes);
  let hasTransparency = false;
  let hasVisiblePixel = false;

  for (let row = 0; row < REFERENCE_PNG_HEIGHT; row += 1) {
    const scanlineOffset = row * EXPECTED_SCANLINE_BYTES;
    const filter = inflated[scanlineOffset];
    if (filter > 4) {
      invalidReferencePng("The reference image uses an invalid PNG scanline filter.");
    }

    for (let column = 0; column < rowBytes; column += 1) {
      const raw = inflated[scanlineOffset + 1 + column];
      const left =
        column >= RGBA_BYTES_PER_PIXEL
          ? current[column - RGBA_BYTES_PER_PIXEL]
          : 0;
      const up = previous[column];
      const upperLeft =
        column >= RGBA_BYTES_PER_PIXEL
          ? previous[column - RGBA_BYTES_PER_PIXEL]
          : 0;
      let reconstructed = raw;
      if (filter === 1) reconstructed += left;
      else if (filter === 2) reconstructed += up;
      else if (filter === 3) reconstructed += Math.floor((left + up) / 2);
      else if (filter === 4) reconstructed += paeth(left, up, upperLeft);
      current[column] = reconstructed & 0xff;
    }

    if (!hasTransparency || !hasVisiblePixel) {
      for (
        let alpha = RGBA_BYTES_PER_PIXEL - 1;
        alpha < rowBytes;
        alpha += RGBA_BYTES_PER_PIXEL
      ) {
        if (current[alpha] < 255) {
          hasTransparency = true;
        }
        if (current[alpha] > 0) hasVisiblePixel = true;
      }
    }

    const swap = previous;
    previous = current;
    current = swap;
  }

  if (!hasTransparency || !hasVisiblePixel) {
    invalidReferencePng(
      "The reference image must contain both visible and transparent pixels.",
    );
  }
}

/**
 * Parse and fully validate the positioned reference-guide contract.
 * The function verifies every PNG chunk and CRC, the exact RGBA IHDR shape,
 * the bounded zlib stream, every scanline filter byte, and real transparency.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<{width: 1024, height: 1024, bitDepth: 8, colorType: 6}>}
 */
export async function validateReferencePng(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 45 ||
    bytes.byteLength > MAX_REFERENCE_PNG_BYTES ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
  ) {
    invalidReferencePng("The reference image must be a valid PNG file.");
  }

  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let seenHeader = false;
  let seenPalette = false;
  let seenImageData = false;
  let imageDataEnded = false;
  let seenEnd = false;
  let compressedBytes = 0;
  /** @type {Array<Uint8Array>} */
  const imageDataChunks = [];

  while (offset < bytes.byteLength) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS || seenEnd || offset + 12 > bytes.byteLength) {
      invalidReferencePng("The reference image has an invalid PNG chunk layout.");
    }

    const dataLength = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    const type = chunkType(bytes, typeOffset);
    const dataOffset = typeOffset + 4;
    const crcOffset = dataOffset + dataLength;
    const nextOffset = crcOffset + 4;
    if (
      dataLength > MAX_REFERENCE_PNG_BYTES ||
      nextOffset > bytes.byteLength
    ) {
      invalidReferencePng("The reference image has a truncated PNG chunk.");
    }
    if (
      crc32(bytes, typeOffset, crcOffset) !== readUint32(bytes, crcOffset)
    ) {
      invalidReferencePng("The reference image failed PNG integrity validation.");
    }
    if (chunkCount === 1 && type !== "IHDR") {
      invalidReferencePng("The reference image must begin with a PNG header.");
    }

    if (type === "IHDR") {
      if (seenHeader || dataLength !== 13 || chunkCount !== 1) {
        invalidReferencePng("The reference image has an invalid PNG header.");
      }
      const width = readUint32(bytes, dataOffset);
      const height = readUint32(bytes, dataOffset + 4);
      const bitDepth = bytes[dataOffset + 8];
      const colorType = bytes[dataOffset + 9];
      const compression = bytes[dataOffset + 10];
      const filter = bytes[dataOffset + 11];
      const interlace = bytes[dataOffset + 12];
      if (
        width !== REFERENCE_PNG_WIDTH ||
        height !== REFERENCE_PNG_HEIGHT ||
        bitDepth !== 8 ||
        colorType !== 6 ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        invalidReferencePng(
          "The reference image must be a non-interlaced 1024 by 1024 8-bit RGBA PNG.",
        );
      }
      seenHeader = true;
    } else if (type === "PLTE") {
      if (
        !seenHeader ||
        seenPalette ||
        seenImageData ||
        dataLength < 3 ||
        dataLength > 768 ||
        dataLength % 3 !== 0
      ) {
        invalidReferencePng("The reference image has an invalid PNG palette.");
      }
      seenPalette = true;
    } else if (type === "IDAT") {
      if (!seenHeader || imageDataEnded) {
        invalidReferencePng("The reference image has non-contiguous PNG pixel data.");
      }
      seenImageData = true;
      compressedBytes += dataLength;
      if (compressedBytes > MAX_REFERENCE_PNG_BYTES) {
        invalidReferencePng("The reference image has too much compressed pixel data.");
      }
      imageDataChunks.push(bytes.subarray(dataOffset, crcOffset));
    } else if (type === "IEND") {
      if (!seenImageData || seenEnd || dataLength !== 0) {
        invalidReferencePng("The reference image has an invalid PNG ending.");
      }
      seenEnd = true;
      if (nextOffset !== bytes.byteLength) {
        invalidReferencePng("The reference image contains data after its PNG ending.");
      }
    } else {
      if ((bytes[typeOffset] & 0x20) === 0) {
        invalidReferencePng("The reference image contains an unsupported PNG chunk.");
      }
      if (seenImageData) imageDataEnded = true;
    }

    if (seenImageData && type !== "IDAT" && type !== "IEND") {
      imageDataEnded = true;
    }
    offset = nextOffset;
  }

  if (!seenHeader || !seenImageData || !seenEnd || offset !== bytes.byteLength) {
    invalidReferencePng("The reference image is missing required PNG data.");
  }

  const inflated = await inflateIdat(imageDataChunks, compressedBytes);
  validateScanlines(inflated);
  return {
    width: REFERENCE_PNG_WIDTH,
    height: REFERENCE_PNG_HEIGHT,
    bitDepth: 8,
    colorType: 6,
  };
}
