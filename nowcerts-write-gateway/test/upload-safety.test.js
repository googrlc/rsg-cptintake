import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  inspectImage,
  detectImageType,
  readDimensions,
  ImageReason,
  ACCEPTED_IMAGE_MIME_TYPES,
  MAX_PIXELS,
} from "../src/documents/image-intake.js";
import { ClamAvScanner, ScanStatus, screenUpload } from "../src/documents/malware-scan.js";
import { ocrImage, OcrReason } from "../src/documents/ocr.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("image types are detected from magic bytes, not the declared header", () => {
  assert.equal(detectImageType(PNG_1X1).mime, "image/png");
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).mime, "image/jpeg");
  assert.equal(detectImageType(Buffer.from([0x49, 0x49, 0x2a, 0x00])).mime, "image/tiff");
  assert.equal(detectImageType(Buffer.from("GIF89a")), null, "GIF is not on the allowlist");
  assert.equal(detectImageType(Buffer.from("<svg xmlns=")), null, "SVG is XML and must be refused");
});

test("a PDF renamed as an image is rejected on its bytes", () => {
  const result = inspectImage(Buffer.from("%PDF-1.7 pretending to be a photo"), { filename: "licence.png" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, ImageReason.UNSUPPORTED_TYPE);
});

test("a valid image is accepted, hashed, and measured", () => {
  const result = inspectImage(PNG_1X1, { filename: "back-of-licence.png" });
  assert.equal(result.ok, true);
  assert.equal(result.document.mime_type, "image/png");
  assert.equal(result.document.width, 1);
  assert.equal(result.document.height, 1);
  assert.match(result.document.sha256, /^[a-f0-9]{64}$/);
});

test("empty and oversized uploads are refused", () => {
  assert.equal(inspectImage(Buffer.alloc(0)).reason, ImageReason.EMPTY);
  assert.equal(inspectImage(PNG_1X1, { maxBytes: 10 }).reason, ImageReason.TOO_LARGE);
});

test("a decompression bomb is refused on declared dimensions", () => {
  // A PNG header claiming 40000x40000 = 1.6 billion pixels.
  const bomb = Buffer.from(PNG_1X1);
  bomb.writeUInt32BE(40000, 16);
  bomb.writeUInt32BE(40000, 20);
  const result = inspectImage(bomb);
  assert.equal(result.ok, false);
  assert.equal(result.reason, ImageReason.TOO_LARGE);
  assert.ok(40000 * 40000 > MAX_PIXELS);
});

test("PNG dimensions are read from the header", () => {
  assert.deepEqual(readDimensions(PNG_1X1, "image/png"), { width: 1, height: 1 });
  assert.equal(readDimensions(Buffer.alloc(4), "image/png"), null);
});

test("the accepted image list is a short explicit allowlist", () => {
  assert.deepEqual(ACCEPTED_IMAGE_MIME_TYPES.sort(), [
    "image/heic", "image/jpeg", "image/png", "image/tiff", "image/webp",
  ]);
});

test("an unconfigured scanner reports NOT_CONFIGURED rather than passing the file", async () => {
  const scanner = new ClamAvScanner({ host: null });
  assert.equal(scanner.configured, false);
  const result = await scanner.scan(PNG_1X1);
  assert.equal(result.ok, false);
  assert.equal(result.status, ScanStatus.NOT_CONFIGURED);
});

test("an unreachable scanner fails closed", async () => {
  // Port 1 on loopback: nothing listens there.
  const scanner = new ClamAvScanner({ host: "127.0.0.1", port: 1, timeoutMs: 1000 });
  const result = await scanner.scan(PNG_1X1);
  assert.equal(result.ok, false);
  assert.equal(result.status, ScanStatus.UNAVAILABLE, "an outage must never read as clean");
});

// A stub clamd that speaks just enough of the wire protocol to prove the
// INSTREAM framing and reply handling are right.
async function withFakeClamd(reply, run) {
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      // The stream ends with a zero-length chunk.
      if (chunk.length >= 4 && chunk.readUInt32BE(chunk.length - 4) === 0) {
        socket.end(`${reply}\0`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(server.address().port);
  } finally {
    server.close();
  }
}

test("a clean verdict from clamd is accepted", async () => {
  const result = await withFakeClamd("stream: OK", (port) =>
    new ClamAvScanner({ host: "127.0.0.1", port }).scan(PNG_1X1));
  assert.equal(result.ok, true);
  assert.equal(result.status, ScanStatus.CLEAN);
});

test("an infected verdict names the signature and blocks the upload", async () => {
  const result = await withFakeClamd("stream: Eicar-Test-Signature FOUND", (port) =>
    new ClamAvScanner({ host: "127.0.0.1", port }).scan(PNG_1X1));
  assert.equal(result.ok, false);
  assert.equal(result.status, ScanStatus.INFECTED);
  assert.equal(result.signature, "Eicar-Test-Signature");
});

test("an unrecognized scanner reply is never treated as clean", async () => {
  const result = await withFakeClamd("ERROR: size limit exceeded", (port) =>
    new ClamAvScanner({ host: "127.0.0.1", port }).scan(PNG_1X1));
  assert.equal(result.ok, false);
  assert.equal(result.status, ScanStatus.UNAVAILABLE);
});

// The upload admission gate — the decision that actually protects the endpoint.
const stub = (configured, result) => ({ configured, scan: async () => result });

test("REQUIRE_MALWARE_SCAN blocks uploads when no scanner is configured", async () => {
  const gate = await screenUpload(PNG_1X1, stub(false), { required: true });
  assert.equal(gate.ok, false);
  assert.equal(gate.statusCode, 503);
  assert.equal(gate.reason, "SCANNER_REQUIRED");
});

test("without the requirement, an unconfigured scanner allows the upload but records it as unscanned", async () => {
  const gate = await screenUpload(PNG_1X1, stub(false), { required: false });
  assert.equal(gate.ok, true);
  assert.equal(gate.scanned, false);
});

test("a clean scan admits the upload and records it as scanned", async () => {
  const gate = await screenUpload(PNG_1X1, stub(true, { ok: true, status: ScanStatus.CLEAN }), { required: true });
  assert.equal(gate.ok, true);
  assert.equal(gate.scanned, true);
});

test("an infected file is a 422 — this file is not acceptable", async () => {
  const gate = await screenUpload(PNG_1X1, stub(true, { ok: false, status: ScanStatus.INFECTED, message: "Malware detected: X." }));
  assert.equal(gate.ok, false);
  assert.equal(gate.statusCode, 422);
  assert.equal(gate.reason, ScanStatus.INFECTED);
});

test("a scanner outage is a 503 — we cannot vouch for any file right now", async () => {
  const gate = await screenUpload(PNG_1X1, stub(true, { ok: false, status: ScanStatus.UNAVAILABLE, message: "unreachable" }));
  assert.equal(gate.ok, false);
  assert.equal(gate.statusCode, 503);
  assert.equal(gate.reason, ScanStatus.UNAVAILABLE);
});

test("a configured scanner is always consulted, even when not required", async () => {
  let called = false;
  const scanner = { configured: true, scan: async () => { called = true; return { ok: true, status: ScanStatus.CLEAN }; } };
  await screenUpload(PNG_1X1, scanner, { required: false });
  assert.equal(called, true, "configuring a scanner must mean every upload is scanned");
});

test("a missing tesseract binary degrades gracefully instead of crashing", async () => {
  const result = await ocrImage(PNG_1X1, { command: "definitely-not-a-real-binary-xyz" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, OcrReason.NOT_AVAILABLE);
  assert.equal(result.text, "");
  assert.match(result.message, /not configured/);
});
