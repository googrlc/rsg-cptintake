import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectPdf, IntakeReason } from "../src/documents/pdf-intake.js";
import { TempDocumentStore } from "../src/documents/temp-store.js";
import {
  emptyFile,
  encryptedPdf,
  notPdf,
  structurelessPdf,
  truncatedPdf,
  validPdf,
} from "./fixtures.js";

test("valid PDF is accepted, hashed, and page-counted", () => {
  const result = inspectPdf(validPdf(), { filename: "dec.pdf" });
  assert.equal(result.ok, true);
  assert.equal(result.document.filename, "dec.pdf");
  assert.match(result.document.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.document.page_count, 1);
});

test("empty upload is rejected", () => {
  assert.equal(inspectPdf(emptyFile()).reason, IntakeReason.EMPTY);
});

test("non-PDF content is rejected by signature", () => {
  assert.equal(inspectPdf(notPdf()).reason, IntakeReason.NOT_PDF);
});

test("oversized upload is rejected", () => {
  const result = inspectPdf(validPdf(), { maxBytes: 10 });
  assert.equal(result.reason, IntakeReason.TOO_LARGE);
});

test("encrypted PDF is rejected", () => {
  assert.equal(inspectPdf(encryptedPdf()).reason, IntakeReason.ENCRYPTED);
});

test("truncated/corrupt PDF is rejected for missing %%EOF", () => {
  assert.equal(inspectPdf(truncatedPdf()).reason, IntakeReason.CORRUPT);
});

test("PDF with no object structure is rejected", () => {
  assert.equal(inspectPdf(structurelessPdf()).reason, IntakeReason.CORRUPT);
});

test("temp store persists, retrieves, and sweeps by TTL", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nowcerts-temp-"));
  const store = new TempDocumentStore(dir, { ttlMs: 1000 });
  const accepted = inspectPdf(validPdf(), { filename: "dec.pdf" });
  await store.put(validPdf(), accepted.document);

  const meta = await store.getMetadata(accepted.document.document_id);
  assert.equal(meta.sha256, accepted.document.sha256);
  const bytes = await store.getBytes(accepted.document.document_id);
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");

  // Not yet expired.
  const acceptedMs = Date.parse(accepted.document.accepted_at);
  assert.deepEqual(await store.sweep(acceptedMs + 500), []);
  // Past TTL: purged.
  const purged = await store.sweep(acceptedMs + 2000);
  assert.deepEqual(purged, [accepted.document.document_id]);
  assert.equal(await store.getMetadata(accepted.document.document_id), null);
});
