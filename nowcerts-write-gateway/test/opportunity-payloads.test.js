import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalLineOfBusiness,
  assignOwner,
  buildProvenance,
  OWNER_LAMAR,
  OWNER_GRETCHEN,
} from "../src/intake/opportunity-payloads.js";

// The gateway no longer fans opportunities out itself — the intake goes through
// Hermes' one intake door, which opens them on approval (see crm-submission.test.js).
// What survives here is the vocabulary the payload still has to speak: line-of-
// business names, who owns a line, and how a source reads on a card.

test("line of business is normalized onto the book's vocabulary", () => {
  assert.equal(canonicalLineOfBusiness("workers compensation"), "Worker's Compensation");
  assert.equal(canonicalLineOfBusiness("Workers Comp"), "Worker's Compensation");
  assert.equal(canonicalLineOfBusiness("GL"), "General Liability");
  assert.equal(canonicalLineOfBusiness("E&O"), "Professional Liability");
  assert.equal(canonicalLineOfBusiness("General Liability"), "General Liability");
  // An unknown line passes through rather than being forced onto a near match,
  // so a genuinely new product stays visible in the pipeline.
  assert.equal(canonicalLineOfBusiness("Cyber Liability"), "Cyber Liability");
  assert.equal(canonicalLineOfBusiness("  "), null);
});

test("personal lines go to Gretchen and commercial to Lamar", () => {
  assert.equal(assignOwner("Homeowners").assigned_to, OWNER_GRETCHEN);
  assert.equal(assignOwner("Personal Auto").assigned_to, OWNER_GRETCHEN);
  assert.equal(assignOwner("Motorcycle").assigned_to, OWNER_GRETCHEN);
  assert.equal(assignOwner("General Liability").assigned_to, OWNER_LAMAR);
  assert.equal(assignOwner("Worker's Compensation").assigned_to, OWNER_LAMAR);
});

test("an unclear line falls back to Lamar and is flagged as a fallback", () => {
  const owner = assignOwner("Cyber Liability");
  assert.equal(owner.assigned_to, OWNER_LAMAR);
  assert.equal(owner.unclear, true);
});

test("an unrecognized line on a personal account still goes to Gretchen", () => {
  const owner = assignOwner("Pet Insurance", { accountType: "Personal Lines" });
  assert.equal(owner.assigned_to, OWNER_GRETCHEN);
  assert.equal(owner.unclear, true);
});

test("assigned_to is a JSON array encoded as a string, not an email or bare name", () => {
  const { assigned_to: owner } = assignOwner("General Liability");
  assert.equal(typeof owner, "string");
  assert.deepEqual(JSON.parse(owner), ["Lamar Coates"]);
  assert.ok(!owner.includes("@"));
});

test("provenance is a readable sentence, not stuffed JSON", () => {
  const description = buildProvenance({
    source: { kind: "pdf", reference: "Golden Rose Risk Profile.pdf", captured_at: "2026-06-03T12:00:00.000Z" },
  });
  assert.match(description, /^Source: pdf "Golden Rose Risk Profile\.pdf" captured 2026-06-03/);
  assert.ok(!description.includes("{"), "citation objects must not be JSON-stuffed");
});

test("unresolved fields are named in the provenance sentence", () => {
  const description = buildProvenance({
    needsReview: [{ field: "current_premium", reason: "MISSING" }, { field: "expiration_date", reason: "MISSING" }],
  });
  assert.match(description, /2 field\(s\) needed review: current_premium, expiration_date/);
});

test("an unclear owner is stated rather than left to look deliberate", () => {
  assert.match(buildProvenance({ unclearOwner: true }), /Owner could not be determined/);
});

test("buildProvenance degrades gracefully with no source", () => {
  assert.equal(buildProvenance(), "Source: RSG intake gate.");
});
