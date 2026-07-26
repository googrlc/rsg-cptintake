import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { RecordCipher, isEnvelope, parseKey } from "../src/storage/record-cipher.js";
import { FileProposalStore } from "../src/store.js";
import { FileIntakeSourceStore } from "../src/intake/source-store.js";

const KEY_HEX = randomBytes(32).toString("hex");

function cipher() {
  return new RecordCipher(parseKey(KEY_HEX));
}

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "rsg-cipher-"));
}

test("parseKey accepts hex and base64 and rejects the wrong length", () => {
  assert.equal(parseKey(KEY_HEX).length, 32);
  assert.equal(parseKey(Buffer.from(KEY_HEX, "hex").toString("base64")).length, 32);
  assert.equal(parseKey(""), null);
  assert.throws(() => parseKey("abcd"), /must be 32 bytes/);
});

test("a record round-trips through encryption unchanged", () => {
  const c = cipher();
  const record = { id: "x", contact: { dob: "1955-04-02", dl: "GA-123456" } };
  const onDisk = c.serialize(record);
  assert.deepEqual(c.deserialize(onDisk), record);
});

test("serialized bytes do not contain the plaintext PII", () => {
  const onDisk = cipher().serialize({ dl_number: "GA-987654", birthday: "1955-04-02" });
  assert.ok(!onDisk.includes("GA-987654"));
  assert.ok(!onDisk.includes("1955-04-02"));
  assert.ok(isEnvelope(JSON.parse(onDisk)));
});

test("a wrong key fails loudly rather than returning garbage", () => {
  const onDisk = cipher().serialize({ secret: "value" });
  const other = new RecordCipher(parseKey(randomBytes(32).toString("hex")));
  assert.throws(() => other.deserialize(onDisk), /failed decryption/);
});

test("tampered ciphertext is rejected by the GCM auth tag", () => {
  const c = cipher();
  const envelope = JSON.parse(c.serialize({ amount: 1 }));
  const bytes = Buffer.from(envelope.data, "base64");
  bytes[0] ^= 0xff;
  envelope.data = bytes.toString("base64");
  assert.throws(() => c.deserialize(JSON.stringify(envelope)), /failed decryption/);
});

test("with no key configured records stay plaintext and still round-trip", () => {
  const plain = new RecordCipher(null);
  assert.equal(plain.enabled, false);
  const onDisk = plain.serialize({ id: "x" });
  assert.ok(onDisk.includes('"id": "x"'));
  assert.deepEqual(plain.deserialize(onDisk), { id: "x" });
});

test("an encrypted record read with no key configured errors instead of crashing opaquely", () => {
  const onDisk = cipher().serialize({ id: "x" });
  assert.throws(() => new RecordCipher(null).deserialize(onDisk), /no encryption key is configured/);
});

test("plaintext records written before encryption was enabled remain readable", async () => {
  const dir = await tempDir();
  const plainStore = new FileIntakeSourceStore(dir, new RecordCipher(null));
  const id = "11111111-1111-1111-1111-111111111111";
  await plainStore.save({ intake_id: id, client: { display_name: "Legacy Co" } });

  // Same directory, now with a key: the pre-existing plaintext file still loads.
  const encryptedStore = new FileIntakeSourceStore(dir, cipher());
  const loaded = await encryptedStore.get(id);
  assert.equal(loaded.client.display_name, "Legacy Co");

  // Rewriting it upgrades the file to an envelope.
  await encryptedStore.save(loaded);
  const raw = await readFile(path.join(dir, `${id}.json`), "utf8");
  assert.ok(isEnvelope(JSON.parse(raw)));
  assert.ok(!raw.includes("Legacy Co"));
});

test("FileProposalStore encrypts proposals on disk but keeps the audit log readable", async () => {
  const dir = await tempDir();
  const store = new FileProposalStore(dir, cipher());
  const id = "22222222-2222-2222-2222-222222222222";
  await store.save({ id, status: "READY_FOR_APPROVAL", proposal: { target: { display_name: "Jarah Group LLC" } } });

  const raw = await readFile(path.join(dir, "proposals", `${id}.json`), "utf8");
  assert.ok(!raw.includes("Jarah Group LLC"), "client name must not be on disk in plaintext");

  assert.equal((await store.get(id)).proposal.target.display_name, "Jarah Group LLC");

  await store.audit({ event: "proposal_prepared", proposal_id: id });
  const audit = await readFile(path.join(dir, "audit.jsonl"), "utf8");
  assert.ok(audit.includes("proposal_prepared"), "audit log stays greppable for incident review");
});

test("list() and activeForTarget() decrypt every stored proposal", async () => {
  const dir = await tempDir();
  const store = new FileProposalStore(dir, cipher());
  await store.save({
    id: "33333333-3333-3333-3333-333333333333",
    status: "READY_FOR_APPROVAL",
    proposal: { target: { database_id: "abc" }, changes: [{ field: "Insured.Name" }] },
  });
  const active = await store.activeForTarget("abc");
  assert.equal(active.length, 1);
  assert.equal(active[0].proposal.changes[0].field, "Insured.Name");
});

test("a missing record still returns null rather than throwing", async () => {
  const store = new FileProposalStore(await tempDir(), cipher());
  assert.equal(await store.get("44444444-4444-4444-4444-444444444444"), null);
});
