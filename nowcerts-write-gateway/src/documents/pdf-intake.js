import { createHash, randomUUID } from "node:crypto";

// Intake validation for uploaded PDFs. This is deliberately dependency-free and
// offline: it inspects raw bytes only. It never logs document content, and it
// rejects anything it cannot positively identify as a well-formed, unencrypted
// PDF. Downstream extraction decides text-vs-image (scanned) and rotation; this
// stage only decides whether a file is safe to accept and store.

export const PDF_MAGIC = Buffer.from("%PDF-", "latin1");
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB

export const IntakeReason = {
  EMPTY: "EMPTY",
  NOT_PDF: "NOT_PDF",
  TOO_LARGE: "TOO_LARGE",
  ENCRYPTED: "ENCRYPTED",
  CORRUPT: "CORRUPT",
};

function scanForMarker(buffer, marker, { fromEnd = false, window = buffer.length } = {}) {
  const needle = Buffer.from(marker, "latin1");
  if (fromEnd) {
    const start = Math.max(0, buffer.length - window);
    return buffer.subarray(start).lastIndexOf(needle) !== -1;
  }
  return buffer.indexOf(needle) !== -1;
}

// Best-effort page count from the raw object stream. Intentionally conservative:
// returns null when it cannot be determined rather than guessing a number.
function countPages(buffer) {
  const text = buffer.toString("latin1");
  const typePage = text.match(/\/Type\s*\/Page(?![sA-Za-z])/g);
  if (typePage && typePage.length > 0) return typePage.length;
  // Linearized/xref-stream PDFs may not expose /Type /Page in cleartext.
  const countMatch = text.match(/\/Count\s+(\d+)/);
  if (countMatch) return Number(countMatch[1]);
  return null;
}

/**
 * Validate and fingerprint an uploaded PDF.
 *
 * @param {Buffer} buffer raw file bytes
 * @param {object} options
 * @param {string} [options.filename] original upload name (preserved for evidence)
 * @param {number} [options.maxBytes]
 * @returns {{ok: boolean, reason?: string, message?: string, document?: object}}
 */
export function inspectPdf(buffer, { filename = "upload.pdf", maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: IntakeReason.EMPTY, message: "Uploaded file is empty." };
  }
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      reason: IntakeReason.TOO_LARGE,
      message: `File is ${buffer.length} bytes; limit is ${maxBytes} bytes.`,
    };
  }
  if (!buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return {
      ok: false,
      reason: IntakeReason.NOT_PDF,
      message: "File does not begin with the %PDF- signature.",
    };
  }
  // A well-formed PDF ends with an %%EOF marker near the tail. Its absence means
  // the file was truncated in transit or is otherwise corrupt.
  if (!scanForMarker(buffer, "%%EOF", { fromEnd: true, window: 4096 })) {
    return {
      ok: false,
      reason: IntakeReason.CORRUPT,
      message: "Missing trailing %%EOF marker; file appears truncated or corrupt.",
    };
  }
  // Encrypted PDFs expose an /Encrypt entry in the trailer. We refuse them at
  // intake rather than attempting a password or partial parse.
  if (scanForMarker(buffer, "/Encrypt")) {
    return {
      ok: false,
      reason: IntakeReason.ENCRYPTED,
      message: "PDF is encrypted; upload an unencrypted copy.",
    };
  }
  // Structural sanity: a usable PDF has at least one indirect object and either
  // a trailer or a document catalog (/Root). Reject files that pass the
  // signature but carry no readable body.
  const hasObject = scanForMarker(buffer, " obj");
  const hasTrailer = scanForMarker(buffer, "trailer", { fromEnd: true, window: 65536 });
  const hasRoot = scanForMarker(buffer, "/Root");
  if (!hasObject || (!hasTrailer && !hasRoot)) {
    return {
      ok: false,
      reason: IntakeReason.CORRUPT,
      message: "PDF has no readable object structure.",
    };
  }

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return {
    ok: true,
    document: {
      document_id: randomUUID(),
      filename,
      byte_size: buffer.length,
      sha256,
      page_count: countPages(buffer),
      accepted_at: new Date().toISOString(),
    },
  };
}
