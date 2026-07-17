import test from "node:test";
import assert from "node:assert/strict";
import { summarizeInsured } from "../src/connectors/nowcerts-mcp.js";

test("insured search result exposes only the fields needed for human matching", () => {
  const summary = summarizeInsured({
    databaseId: "11111111-1111-4111-8111-111111111111",
    commercialName: "Example LLC",
    eMail: "office@example.test",
    phone: "4045550100",
    addressLine1: "10 Main St",
    city: "Atlanta",
    state: "GA",
    zipCode: "30303",
    active: true,
    dateOfBirth: "1980-01-01",
    internalSecret: "never expose",
  });
  assert.deepEqual(summary, {
    database_id: "11111111-1111-4111-8111-111111111111",
    display_name: "Example LLC",
    email: "office@example.test",
    phone: "4045550100",
    address: "10 Main St, Atlanta, GA, 30303",
    active: true,
  });
});

test("personal insured name is composed when commercial name is absent", () => {
  const summary = summarizeInsured({ DatabaseId: "abc", FirstName: "Jane", LastName: "Doe" });
  assert.equal(summary.display_name, "Jane Doe");
  assert.equal(summary.database_id, "abc");
});
