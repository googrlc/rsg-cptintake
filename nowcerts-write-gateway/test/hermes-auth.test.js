import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HermesPreviewClient, hermesTokenFromEnv, HermesTokenError } from "../src/connectors/hermes-preview.js";

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
