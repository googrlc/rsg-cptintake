import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareSourceBundle } from "../src/intake/source-bundle.js";
import { FileIntakeSourceStore } from "../src/intake/source-store.js";

const capturedAt = "2026-07-17T12:00:00.000Z";
const documentId = "11111111-1111-4111-8111-111111111111";

function mixedSources() {
  return [
    {
      kind: "pdf",
      document_id: documentId,
      title: "Current declaration pages",
      filename: "dec-pages.pdf",
      byte_size: 2048,
      sha256: "a".repeat(64),
      page_count: 4,
      captured_at: capturedAt,
    },
    {
      kind: "transcript",
      title: "Client call",
      content: "The client performs commercial landscaping and snow removal.",
      captured_at: capturedAt,
    },
    {
      kind: "notes",
      title: "Apple Notes",
      content: "Ten employees. Uses subcontractors for tree removal.",
      captured_at: capturedAt,
    },
  ];
}

test("prepares one cited multi-source bundle for synthesis", () => {
  const bundle = prepareSourceBundle(
    { client_name: "Example Landscaping LLC", existing_client_id: null, sources: mixedSources() },
    { intakeId: "22222222-2222-4222-8222-222222222222", now: capturedAt },
  );
  assert.equal(bundle.status, "READY_FOR_SYNTHESIS");
  assert.deepEqual(bundle.source_counts, { pdf: 1, transcript: 1, notes: 1, manual_facts: 0 });
  assert.equal(bundle.client.intended_operation, "create");
  assert.equal(bundle.pipeline.nowcerts_preview, "NOT_CONFIGURED");
  assert.equal(bundle.live_writes, false);
  assert.deepEqual(bundle.source_index.map((source) => source.source_id), ["SRC-001", "SRC-002", "SRC-003"]);
});

test("requires at least one source and a client name", () => {
  assert.throws(
    () => prepareSourceBundle({ client_name: "", existing_client_id: null, sources: [] }),
    /too_small|Too small|expected string/i,
  );
});

test("private source store persists the full bundle", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rsg-source-store-"));
  const store = new FileIntakeSourceStore(dir);
  const bundle = prepareSourceBundle(
    { client_name: "Example Landscaping LLC", existing_client_id: "INS-22", sources: mixedSources() },
    { intakeId: "33333333-3333-4333-8333-333333333333", now: capturedAt },
  );
  await store.save(bundle);
  const loaded = await store.get(bundle.intake_id);
  assert.equal(loaded.sources[1].content, mixedSources()[1].content);
  const mode = (await stat(path.join(dir, `${bundle.intake_id}.json`))).mode & 0o777;
  assert.equal(mode, 0o600);
});
