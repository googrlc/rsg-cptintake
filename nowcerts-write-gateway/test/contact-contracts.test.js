import test from "node:test";
import assert from "node:assert/strict";
import {
  SENSITIVE_FIELDS,
  listFieldContracts,
  normalizeFieldKey,
  resolveFieldContract,
} from "../src/contracts/nowcerts-field-contracts.js";
import { parseContactResult } from "../src/connectors/momentum-write.js";
import { splitContactName } from "../src/intake/live-pipeline.js";

const CONTACT_TOOL = "insert_insured_prospect_primary_contact_in_ams_tool";
const CONTACT_READ = "get_insured_contact_details_tool";

test("indexed contact fields normalize to a single contract key", () => {
  assert.deepEqual(normalizeFieldKey("Contact[3].Phone"), { key: "Contact.Phone", index: 3 });
  assert.deepEqual(normalizeFieldKey("Insured.Name"), { key: "Insured.Name", index: null });
});

test("contact fields resolve to the documented insert tool and read-back", () => {
  const contract = resolveFieldContract("Contact[1].Phone", "create");
  assert.equal(contract.write_tool, CONTACT_TOOL);
  assert.equal(contract.write_field, "cell_phone");
  assert.equal(contract.read_tool, CONTACT_READ);
  assert.equal(contract.entity, "contact");
  assert.equal(contract.contact_index, 1);
});

test("the contact tool is insert-or-update, so both operations resolve", () => {
  for (const operation of ["create", "update"]) {
    assert.ok(resolveFieldContract("Contact[1].FirstName", operation), `${operation} must resolve`);
  }
});

test("DOB and driver licence are contracted and flagged sensitive", () => {
  for (const field of ["Contact[1].DOB", "Contact[1].LicenseNumber", "Contact[1].LicenseState"]) {
    const contract = resolveFieldContract(field, "create");
    assert.ok(contract, `${field} must have a contract`);
    assert.equal(contract.sensitive, true, `${field} must be marked sensitive`);
  }
  assert.equal(resolveFieldContract("Contact[1].Phone", "create").sensitive, false);
  assert.deepEqual(SENSITIVE_FIELDS.sort(), ["Contact.DOB", "Contact.LicenseNumber", "Contact.LicenseState"]);
});

test("uncontracted contact fields still return null and stay report-only", () => {
  assert.equal(resolveFieldContract("Contact[1].Nickname", "create"), null);
  // A single-token name has no contract, so it lands on the report for a human.
  assert.equal(resolveFieldContract("Contact[1].Name", "create"), null);
});

test("every contract has both a write path and a read-back path", () => {
  for (const [field, contract] of Object.entries(listFieldContracts())) {
    assert.ok(contract.read, `${field} must declare a read-back path`);
    assert.ok(contract.create || contract.update, `${field} must declare a write path`);
  }
});

test("splitContactName separates first and last without inventing a surname", () => {
  assert.deepEqual(splitContactName("Jane Ukoh"), { first: "Jane", last: "Ukoh" });
  assert.deepEqual(splitContactName("  Uko  Ukoh "), { first: "Uko", last: "Ukoh" });
  // Middle tokens join the first name rather than being guessed into a surname.
  assert.deepEqual(splitContactName("Mary Jane Smith"), { first: "Mary Jane", last: "Smith" });
  assert.deepEqual(splitContactName("Cher"), { first: null, last: null });
  assert.deepEqual(splitContactName(""), { first: null, last: null });
  assert.deepEqual(splitContactName(null), { first: null, last: null });
});

test("a successful contact write is parsed into an id", () => {
  const result = parseContactResult(JSON.stringify({ insuredDatabaseId: "ins-1", primaryContactId: "c-9" }));
  assert.equal(result.ok, true);
  assert.equal(result.status, "WRITTEN");
  assert.equal(result.contact_database_id, "c-9");
});

test("a duplicate contact is neither success nor failure — it is an operator question", () => {
  const result = parseContactResult(JSON.stringify({ duplicateFound: true, databaseId: "existing-7" }));
  assert.equal(result.ok, false);
  assert.equal(result.status, "DUPLICATE_CONTACT");
  assert.equal(result.contact_database_id, "existing-7");
  assert.match(result.message, /Confirm before updating/);
});

test("an unparseable contact response fails closed", () => {
  const result = parseContactResult("upstream exploded");
  assert.equal(result.ok, false);
  assert.equal(result.status, "WRITE_FAILED");
  assert.equal(result.contact_database_id, null);
});
