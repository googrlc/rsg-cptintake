import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MomentumWriteClient, parseInsertResult, resultText } from "../src/connectors/momentum-write.js";

const TOKEN_FILE = path.join(tmpdir(), "rsg-momentum-test-token");
writeFileSync(TOKEN_FILE, "test-bearer-key\n");

function fakeFactory(client, captured = {}) {
  return async ({ authorization }) => {
    captured.authorization = authorization;
    return { client, close: async () => {} };
  };
}

test("parseInsertResult extracts insuredDatabaseId across shapes", () => {
  assert.equal(parseInsertResult('{"insuredDatabaseId":"abc-1"}').insured_database_id, "abc-1");
  assert.equal(parseInsertResult('{"data":{"insuredDatabaseId":"d-2"}}').insured_database_id, "d-2");
  assert.equal(parseInsertResult("11111111-2222-4333-8444-555555555555").insured_database_id, "11111111-2222-4333-8444-555555555555");
  const failed = parseInsertResult("Error: missing required field state");
  assert.equal(failed.ok, false);
  assert.match(failed.message, /missing required field/);
});

test("resultText joins text content parts", () => {
  assert.equal(resultText({ content: [{ text: "a" }, { text: "b" }] }), "ab");
  assert.equal(resultText({ content: [] }), "");
});

test("insertInsuredProspect calls the tool through the injected client and parses the id", async () => {
  const calls = [];
  const captured = {};
  const client = {
    async callTool(params) {
      calls.push(params);
      return { content: [{ type: "text", text: '{"insuredDatabaseId":"NEW-9"}' }] };
    },
  };
  const writer = new MomentumWriteClient({ url: "https://example/mcp", tokenFile: TOKEN_FILE, clientFactory: fakeFactory(client, captured) });
  const result = await writer.insertInsuredProspect({ commercialName: "X", type: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.insured_database_id, "NEW-9");
  assert.equal(calls[0].name, "insert_insured_prospect_tool");
  assert.equal(calls[0].arguments.type, 1);
  assert.equal(captured.authorization, "Bearer test-bearer-key", "raw key gets a Bearer prefix");
});

test("insertInsuredProspect surfaces a tool error", async () => {
  const client = { async callTool() { return { isError: true, content: [{ text: "state is required" }] }; } };
  const writer = new MomentumWriteClient({ url: "u", tokenFile: TOKEN_FILE, clientFactory: fakeFactory(client) });
  await assert.rejects(() => writer.insertInsuredProspect({}), /state is required/);
});
