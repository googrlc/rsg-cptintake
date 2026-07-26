// PDF417 barcode decoding, fully offline.
//
// The WASM binary is read from node_modules on disk and handed to the module
// explicitly. zxing-wasm would otherwise resolve it over the network, which is
// unacceptable here: the gateway runs on a private tailnet and driver's licence
// images must never leave the host. If the binary is missing the decoder stays
// disabled and reports NOT_AVAILABLE rather than silently falling back to a
// remote fetch.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const BarcodeReason = {
  NOT_AVAILABLE: "NOT_AVAILABLE",
  NO_BARCODE: "NO_BARCODE",
  DECODE_FAILED: "DECODE_FAILED",
};

let readerPromise = null;

async function loadReader() {
  const reader = await import("zxing-wasm/reader");
  const wasmBinary = await readFile(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
  reader.prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
  return reader;
}

function reader() {
  readerPromise ??= loadReader();
  return readerPromise;
}

/**
 * Decode every PDF417 symbol in an image.
 *
 * @param {Buffer} bytes raw image bytes (PNG/JPEG/etc.)
 * @param {object} [options]
 * @param {string[]} [options.formats] barcode formats to look for
 * @returns {Promise<{ok: boolean, reason?: string, message?: string, symbols: string[]}>}
 */
export async function decodeBarcodes(bytes, { formats = ["PDF417"], timeoutMs = 20_000 } = {}) {
  let zxing;
  try {
    zxing = await reader();
  } catch (error) {
    readerPromise = null;
    return { ok: false, reason: BarcodeReason.NOT_AVAILABLE, message: `Barcode decoder unavailable: ${error.message}`, symbols: [] };
  }

  // The timer must be cleared on the winning path: an uncleared timeout keeps
  // the event loop alive for its full duration after every successful decode,
  // which stalls process shutdown and pins the closure in memory.
  let timer = null;
  try {
    const blob = new Blob([bytes]);
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Barcode decoding timed out.")), timeoutMs);
      timer.unref?.();
    });
    const results = await Promise.race([
      zxing.readBarcodesFromImageFile(blob, { formats, tryHarder: true }),
      deadline,
    ]);
    const symbols = (results ?? []).filter((r) => r?.isValid !== false && r?.text).map((r) => r.text);
    if (symbols.length === 0) {
      return { ok: false, reason: BarcodeReason.NO_BARCODE, message: "No readable PDF417 barcode found in the image.", symbols: [] };
    }
    return { ok: true, symbols };
  } catch (error) {
    return { ok: false, reason: BarcodeReason.DECODE_FAILED, message: `Barcode decoding failed: ${error.message}`, symbols: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
