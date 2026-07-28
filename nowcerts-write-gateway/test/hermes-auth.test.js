import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HermesPreviewClient, hermesTokenFromEnv, intakeKeyFromEnv, HermesTokenError } from "../src/connectors/hermes-preview.js";

function capture(response = { ok: true }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => response };
  };
  return { calls, fetchImpl };
}

async function tokenFile(contents) {
  const dir = await mkdtemp(path.join(tmpdir(), "rsg-hermes-"));
  const file = path.join(dir, "token");
  await writeFile(file, contents);
  return file;
}

test("no token configured means no Authorization header — unchanged behaviour", async () => {
  const { calls, fetchImpl } = capture();
  const client = new HermesPreviewClient({ url: "http://hermes-api:8787", fetchImpl });
  assert.equal(client.authenticated, false);
  await client.createOpportunity({ line_of_business: "General Liability" });
  assert.equal(calls[0].init.headers.authorization, undefined);
});

test("a configured token is sent as a bearer on every request", async () => {
  const { calls, fetchImpl } = capture();
  const client = new HermesPreviewClient({ url: "http://hermes-api:8787", fetchImpl, token: "s3cret" });
  assert.equal(client.authenticated, true);
  await client.createOpportunity({ line_of_business: "General Liability" });
  await client.stageDraft({ rawText: "x", submittedBy: "lamar", sourceRef: "r" });
  for (const call of calls) assert.equal(call.init.headers.authorization, "Bearer s3cret");
});

// The 2026-07-26 bridge outage in one test: an empty token must never silently
// become "no authentication".
test("an empty HERMES_API_TOKEN is refused, not silently treated as no-auth", () => {
  assert.throws(() => hermesTokenFromEnv({ HERMES_API_TOKEN: "" }), HermesTokenError);
  assert.throws(() => hermesTokenFromEnv({ HERMES_API_TOKEN: "   " }), /silently disables authentication/);
});

test("an empty token FILE is refused for the same reason", async () => {
  const file = await tokenFile("\n");
  assert.throws(() => hermesTokenFromEnv({ HERMES_API_TOKEN_FILE: file }), /is empty/);
});

test("an unreadable token file fails loudly rather than falling back to anonymous", () => {
  assert.throws(
    () => hermesTokenFromEnv({ HERMES_API_TOKEN_FILE: "/nonexistent/hermes-token" }),
    /could not be read/,
  );
});

test("a token file is read and trimmed", async () => {
  const file = await tokenFile("  abc123\n");
  assert.equal(hermesTokenFromEnv({ HERMES_API_TOKEN_FILE: file }), "abc123");
});

test("no token variables at all is a valid explicit configuration", () => {
  assert.equal(hermesTokenFromEnv({}), null);
});

test("the file form wins over the inline form", async () => {
  const file = await tokenFile("from-file");
  assert.equal(hermesTokenFromEnv({ HERMES_API_TOKEN_FILE: file, HERMES_API_TOKEN: "inline" }), "from-file");
});

test("a whitespace-only constructor token yields no header, never a malformed one", async () => {
  const { calls, fetchImpl } = capture();
  const client = new HermesPreviewClient({ url: "http://h:1", fetchImpl, token: "   " });
  assert.equal(client.authenticated, false);
  await client.createOpportunity({});
  assert.equal(calls[0].init.headers.authorization, undefined);
});

test("a 401 with no token configured explains the actual fix", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ detail: "invalid or missing bearer token" }) });
  const client = new HermesPreviewClient({ url: "http://h:1", fetchImpl });
  await assert.rejects(
    () => client.createOpportunity({}),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.match(error.message, /requires a bearer token; set HERMES_API_TOKEN_FILE/);
      return true;
    },
  );
});

test("a 401 while authenticated reports the token as wrong, without the setup hint", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ detail: "invalid or missing bearer token" }) });
  const client = new HermesPreviewClient({ url: "http://h:1", fetchImpl, token: "wrong" });
  await assert.rejects(
    () => client.createOpportunity({}),
    (error) => {
      assert.match(error.message, /invalid or missing bearer token/);
      assert.ok(!/set HERMES_API_TOKEN_FILE/.test(error.message), "no setup hint when a token is already configured");
      return true;
    },
  );
});

// --- the intake key (a different credential from the bearer) ----------------

test("the intake key is sent as X-RSG-API-Key, alongside the bearer not instead of it", async () => {
  const { calls, fetchImpl } = capture();
  const client = new HermesPreviewClient({ url: "http://h:1", fetchImpl, token: "bearer-tok", intakeKey: "intake-key" });
  assert.equal(client.canSubmitIntake, true);
  await client.submitIntake({ idempotency_key: "k" });
  assert.equal(calls[0].url, "http://h:1/api/intake");
  assert.equal(calls[0].init.headers["x-rsg-api-key"], "intake-key");
  assert.equal(calls[0].init.headers.authorization, "Bearer bearer-tok");
});

test("submitting without an intake key names the fix rather than 401-ing at the far end", async () => {
  const { calls, fetchImpl } = capture();
  const client = new HermesPreviewClient({ url: "http://h:1", fetchImpl });
  assert.equal(client.canSubmitIntake, false);
  await assert.rejects(
    () => client.submitIntake({}),
    (error) => {
      assert.match(error.message, /set HERMES_INTAKE_KEY_FILE/);
      return true;
    },
  );
  assert.equal(calls.length, 0, "no request is made without the key");
});

test("the two credentials are independent — a bearer alone does not enable intake submission", () => {
  const client = new HermesPreviewClient({ url: "http://h:1", token: "bearer-tok" });
  assert.equal(client.authenticated, true);
  assert.equal(client.canSubmitIntake, false);
});

test("an empty HERMES_INTAKE_KEY is refused, not treated as 'disabled'", () => {
  assert.throws(() => intakeKeyFromEnv({ HERMES_INTAKE_KEY: "  " }), HermesTokenError);
  assert.throws(() => intakeKeyFromEnv({ HERMES_INTAKE_KEY: "" }), HermesTokenError);
});

test("no intake key variables at all is a valid explicit configuration", () => {
  assert.equal(intakeKeyFromEnv({}), null);
});

test("an intake key file is read and trimmed, and an empty one is refused", async () => {
  const good = await tokenFile("  intake-key-from-file\n");
  assert.equal(intakeKeyFromEnv({ HERMES_INTAKE_KEY_FILE: good }), "intake-key-from-file");
  const empty = await tokenFile("   \n");
  assert.throws(() => intakeKeyFromEnv({ HERMES_INTAKE_KEY_FILE: empty }), HermesTokenError);
});

test("an unreadable intake key file fails loudly rather than disabling submission", () => {
  assert.throws(() => intakeKeyFromEnv({ HERMES_INTAKE_KEY_FILE: "/nonexistent/rsg-intake-key" }), HermesTokenError);
});
