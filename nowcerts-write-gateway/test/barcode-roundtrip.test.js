// End-to-end proof that a real PDF417 symbol decodes to the right cardholder
// fields, entirely offline. Encodes an AAMVA payload to a PNG with the bundled
// ZXing writer, then reads it back through the production decode path.
//
// This is the test that would catch the WASM being fetched from a CDN, the
// decoder silently failing, or the AAMVA element split regressing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { decodeBarcodes } from "../src/documents/barcode.js";
import { readDriverLicense, LicenseStatus } from "../src/documents/license-intake.js";
import { samplePayload } from "./fixtures.js";

const require = createRequire(import.meta.url);

async function encodePdf417(text) {
  const writer = await import("zxing-wasm/writer");
  writer.prepareZXingModule({
    overrides: { wasmBinary: await readFile(require.resolve("zxing-wasm/writer/zxing_writer.wasm")) },
    fireImmediately: true,
  });
  const written = await writer.writeBarcode(text, { format: "PDF417", scale: 3 });
  return Buffer.from(await written.image.arrayBuffer());
}

test("a generated PDF417 symbol decodes back to the exact payload", async () => {
  const payload = samplePayload();
  const png = await encodePdf417(payload);
  const decoded = await decodeBarcodes(png);
  assert.equal(decoded.ok, true, decoded.message);
  assert.equal(decoded.symbols[0], payload, "decode must be byte-exact, not approximate");
});

test("a photographed licence reads end to end into contact fields", async () => {
  const png = await encodePdf417(samplePayload());
  const result = await readDriverLicense(png, { contactIndex: 1 });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.status, LicenseStatus.READ);
  assert.equal(result.fields.first_name, "JANE");
  assert.equal(result.fields.last_name, "UKOH");
  assert.equal(result.fields.date_of_birth, "1955-04-02");
  assert.equal(result.fields.license_number, "059123456");

  const byField = Object.fromEntries(result.contact_fields.map((m) => [m.field, m.value]));
  assert.equal(byField["Contact[1].DOB"], "1955-04-02");
  assert.equal(byField["Contact[1].LicenseNumber"], "059123456");
  assert.equal(byField["Contact[1].LicenseState"], "GA");
});

test("an image with no barcode reports NO_BARCODE rather than throwing", async () => {
  // A 1x1 PNG: structurally valid, carries no symbol.
  const blank = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const result = await decodeBarcodes(blank);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NO_BARCODE");
  assert.deepEqual(result.symbols, []);
});

test("garbage bytes fail closed instead of returning a bogus symbol", async () => {
  const result = await decodeBarcodes(Buffer.from("this is not an image at all"));
  assert.equal(result.ok, false);
  assert.deepEqual(result.symbols, []);
});
