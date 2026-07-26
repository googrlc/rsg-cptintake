// OCR for images and scanned PDFs, via a local Tesseract binary.
//
// Shells out the same way pdf-text.js shells out to pdftotext: no network, no
// third-party service, output bounded and timed out. Scanned carrier documents
// (ACORDs, dec pages, loss runs) are the target — the extracted text is evidence
// for the citation pipeline, and every fact drawn from it still passes through
// human review before it can reach the AMS.
//
// OCR is inherently lossy. This module reports mean per-word confidence so the
// caller can flag a low-quality scan for manual review rather than presenting
// uncertain text as fact.

import { spawn } from "node:child_process";

export const MAX_OCR_CHARS = 200_000;
export const DEFAULT_OCR_TIMEOUT_MS = 120_000;
// Below this mean confidence the scan is treated as unreliable and surfaced for
// manual review. Tesseract reports 0-100 per word.
export const LOW_CONFIDENCE_THRESHOLD = 60;

export const OcrReason = {
  NOT_AVAILABLE: "NOT_AVAILABLE",
  FAILED: "FAILED",
  TIMED_OUT: "TIMED_OUT",
};

function run(command, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    let outBytes = 0;
    let errorText = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes <= MAX_OCR_CHARS * 4) out.push(chunk);
    });
    child.stderr.on("data", (chunk) => { errorText += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(Object.assign(new Error("OCR timed out."), { reason: OcrReason.TIMED_OUT }));
      if (code !== 0) return reject(new Error(errorText.trim() || `tesseract exited ${code}`));
      resolve(Buffer.concat(out).toString("utf8"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// Tesseract's TSV output carries a confidence column; -1 marks layout rows that
// hold no word, so they are excluded from the mean.
function meanConfidence(tsv) {
  const lines = tsv.split("\n").slice(1);
  const scores = [];
  for (const line of lines) {
    const columns = line.split("\t");
    if (columns.length < 12) continue;
    const confidence = Number(columns[10]);
    const word = (columns[11] ?? "").trim();
    if (Number.isFinite(confidence) && confidence >= 0 && word) scores.push(confidence);
  }
  if (scores.length === 0) return null;
  return Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10) / 10;
}

/**
 * OCR an image buffer.
 *
 * @param {Buffer} bytes raw image bytes
 * @param {object} [options]
 * @returns {Promise<{ok: boolean, reason?: string, message?: string, text: string,
 *   confidence: number|null, low_confidence: boolean, truncated: boolean}>}
 */
export async function ocrImage(bytes, {
  command = process.env.TESSERACT_BIN ?? "tesseract",
  language = process.env.TESSERACT_LANG ?? "eng",
  timeoutMs = DEFAULT_OCR_TIMEOUT_MS,
} = {}) {
  let text;
  try {
    text = await run(command, ["stdin", "stdout", "-l", language], bytes, timeoutMs);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: false,
        reason: OcrReason.NOT_AVAILABLE,
        message: "OCR is not configured on this host (tesseract binary not found).",
        text: "", confidence: null, low_confidence: false, truncated: false,
      };
    }
    return {
      ok: false,
      reason: error?.reason ?? OcrReason.FAILED,
      message: `OCR failed: ${error.message}`,
      text: "", confidence: null, low_confidence: false, truncated: false,
    };
  }

  // Second pass for confidence only. A failure here degrades to "no confidence
  // reported" rather than discarding perfectly good text.
  let confidence = null;
  try {
    confidence = meanConfidence(await run(command, ["stdin", "stdout", "-l", language, "tsv"], bytes, timeoutMs));
  } catch {
    confidence = null;
  }

  const cleaned = text.replace(/\u0000/g, "").trim();
  return {
    ok: true,
    text: cleaned.slice(0, MAX_OCR_CHARS),
    truncated: cleaned.length > MAX_OCR_CHARS,
    confidence,
    low_confidence: confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD,
  };
}
