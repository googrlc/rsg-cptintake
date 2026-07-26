// Intake validation for uploaded images (driver's licences, photographed
// documents). Mirrors pdf-intake.js: dependency-free, offline, raw-byte
// inspection only, and it rejects anything it cannot positively identify.
//
// Accepting images widens the attack surface well beyond pdftotext, so the
// allowlist here is deliberately short and every accepted type is confirmed by
// magic bytes rather than by the client-supplied Content-Type header, which is
// attacker-controlled. Malware scanning runs separately and is mandatory in
// production — see malware-scan.js.

import { createHash, randomUUID } from "node:crypto";

export const DEFAULT_MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MiB

export const ImageReason = {
  EMPTY: "EMPTY",
  TOO_LARGE: "TOO_LARGE",
  UNSUPPORTED_TYPE: "UNSUPPORTED_TYPE",
  CORRUPT: "CORRUPT",
};

// Formats Tesseract and zxing both handle, identified by signature. SVG is
// deliberately excluded: it is XML, can carry script, and is never a photo of a
// licence. TIFF is included because scanners still emit it.
const SIGNATURES = [
  { mime: "image/jpeg", ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/png", ext: "png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/tiff", ext: "tif", magic: [0x49, 0x49, 0x2a, 0x00] },
  { mime: "image/tiff", ext: "tif", magic: [0x4d, 0x4d, 0x00, 0x2a] },
  { mime: "image/webp", ext: "webp", magic: [0x52, 0x49, 0x46, 0x46], offsetMagic: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  { mime: "image/heic", ext: "heic", offsetMagic: { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] } },
];

export const ACCEPTED_IMAGE_MIME_TYPES = [...new Set(SIGNATURES.map((s) => s.mime))];

function startsWith(buffer, bytes, offset = 0) {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

export function detectImageType(buffer) {
  for (const signature of SIGNATURES) {
    const leadOk = signature.magic ? startsWith(buffer, signature.magic) : true;
    const offsetOk = signature.offsetMagic
      ? startsWith(buffer, signature.offsetMagic.bytes, signature.offsetMagic.offset)
      : true;
    if (leadOk && offsetOk) return { mime: signature.mime, ext: signature.ext };
  }
  return null;
}

// Dimensions for the formats where the header makes it cheap. Used only to
// reject decompression bombs; null means "not determined", never a guess.
export function readDimensions(buffer, mime) {
  try {
    if (mime === "image/png" && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        // SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// 80 megapixels: far above any licence photo or document scan, low enough that
// a decompression bomb cannot exhaust memory in the OCR/decode step.
export const MAX_PIXELS = 80_000_000;

/**
 * Validate and fingerprint an uploaded image.
 *
 * @param {Buffer} buffer raw file bytes
 * @param {object} options
 * @returns {{ok: boolean, reason?: string, message?: string, document?: object}}
 */
export function inspectImage(buffer, { filename = "upload", maxBytes = DEFAULT_MAX_IMAGE_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: ImageReason.EMPTY, message: "Uploaded file is empty." };
  }
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      reason: ImageReason.TOO_LARGE,
      message: `File is ${buffer.length} bytes; limit is ${maxBytes} bytes.`,
    };
  }
  const detected = detectImageType(buffer);
  if (!detected) {
    return {
      ok: false,
      reason: ImageReason.UNSUPPORTED_TYPE,
      message: `Unsupported image type. Accepted: ${ACCEPTED_IMAGE_MIME_TYPES.join(", ")}.`,
    };
  }
  const dimensions = readDimensions(buffer, detected.mime);
  if (dimensions && (dimensions.width <= 0 || dimensions.height <= 0)) {
    return { ok: false, reason: ImageReason.CORRUPT, message: "Image reports zero width or height." };
  }
  if (dimensions && dimensions.width * dimensions.height > MAX_PIXELS) {
    return {
      ok: false,
      reason: ImageReason.TOO_LARGE,
      message: `Image is ${dimensions.width}x${dimensions.height}; limit is ${MAX_PIXELS} pixels.`,
    };
  }

  return {
    ok: true,
    document: {
      document_id: randomUUID(),
      filename,
      mime_type: detected.mime,
      byte_size: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      accepted_at: new Date().toISOString(),
    },
  };
}
