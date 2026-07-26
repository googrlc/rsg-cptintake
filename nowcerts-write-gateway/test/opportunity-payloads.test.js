import test from "node:test";
import assert from "node:assert/strict";
import {
  toOpportunityPayloads,
  canonicalLineOfBusiness,
  assignOwner,
  buildProvenance,
  OWNER_LAMAR,
  OWNER_GRETCHEN,
  OPPORTUNITY_SOURCE,
} from "../src/intake/opportunity-payloads.js";
import { writeOpportunities, CrmWriteStatus } from "../src/intake/crm-writer.js";

function crmBundle({ lobs = ["General Liability"], existingClientId = null, extraFields = {}, accountType = "Commercial Lines" } = {}) {
  return {
    client: { display_name: "Jarah Group LLC", existing_client_id: existingClientId },
    source_index: [{ source_id: "SRC-001", kind: "pdf", reference: "Golden Rose Risk Profile.pdf", captured_at: "2026-06-03T12:00:00.000Z" }],
    crm_records: [
      ...lobs.map((lob, index) => ({
        destination: "hermes", entity: "opportunity", role: "opportunity", operation: "create", index: index + 1,
        fields: [
          { field: "line_of_business", value: lob, citation: "SRC-001" },
          ...Object.entries(extraFields).map(([field, value]) => ({ field, value, citation: "SRC-001" })),
        ],
        needs_review: [], nowcerts_write: "manual",
      })),
      {
        destination: "hermes", entity: "account", role: "account_context", operation: "update", index: null,
        fields: [{ field: "account_type", value: accountType, citation: "SRC-001" }],
        needs_review: [], nowcerts_write: "manual",
      },
    ],
  };
}

test("six lines of business produce six payloads, one per LOB", () => {
  const lobs = ["General Liability", "Worker's Compensation", "Commercial Property", "Commercial Auto", "Professional Liability", "Homeowners"];
  const { payloads } = toOpportunityPayloads(crmBundle({ lobs }));
  assert.equal(payloads.length, 6);
  assert.deepEqual(payloads.map((p) => p.line_of_business), lobs);
  // Never a bundled package row.
  assert.ok(!payloads.some((p) => /package/i.test(p.line_of_business)));
});

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

test("an unclear line falls back to Lamar and says so", () => {
  const owner = assignOwner("Cyber Liability");
  assert.equal(owner.assigned_to, OWNER_LAMAR);
  assert.equal(owner.unclear, true);
  const { payloads } = toOpportunityPayloads(crmBundle({ lobs: ["Cyber Liability"] }));
  assert.match(payloads[0].description, /Owner could not be determined/);
});

test("assigned_to is a JSON array encoded as a string, not an email or bare name", () => {
  const { payloads } = toOpportunityPayloads(crmBundle());
  assert.equal(typeof payloads[0].assigned_to, "string");
  assert.deepEqual(JSON.parse(payloads[0].assigned_to), ["Lamar Coates"]);
  assert.ok(!payloads[0].assigned_to.includes("@"));
});

test("an existing client is a cross-sell; a new prospect is new business", () => {
  assert.equal(toOpportunityPayloads(crmBundle()).payloads[0].opportunity_type, "New Business");
  const existing = crmBundle({ existingClientId: "f81fddd9-b264-459e-8b7f-c39201494a53" });
  const { payloads } = toOpportunityPayloads(existing, { insuredId: existing.client.existing_client_id });
  assert.equal(payloads[0].opportunity_type, "Cross-selling");
  assert.equal(payloads[0].insured_id, "f81fddd9-b264-459e-8b7f-c39201494a53");
});

test("provenance is a readable sentence, not stuffed JSON", () => {
  const { payloads } = toOpportunityPayloads(crmBundle());
  assert.match(payloads[0].description, /^Source: pdf "Golden Rose Risk Profile\.pdf" captured 2026-06-03/);
  assert.ok(!payloads[0].description.includes("{"), "citation objects must not be JSON-stuffed");
});

test("unresolved fields are named in the description, and the opportunity is still created", () => {
  const bundle = crmBundle();
  bundle.crm_records[0].needs_review = [{ field: "current_premium", reason: "MISSING" }, { field: "expiration_date", reason: "MISSING" }];
  const { payloads } = toOpportunityPayloads(bundle);
  assert.equal(payloads.length, 1, "a gap must not suppress the opportunity");
  assert.match(payloads[0].description, /2 field\(s\) needed review: current_premium, expiration_date/);
});

test("optional fields are omitted rather than sent as null", () => {
  const { payloads } = toOpportunityPayloads(crmBundle());
  for (const key of ["fein", "insured_id", "premium_estimate", "carrier"]) {
    assert.ok(!(key in payloads[0]), `${key} must be absent, not null`);
  }
  const withExtras = toOpportunityPayloads(crmBundle({ extraFields: { current_premium: 8400, current_carrier: "Progressive" } })).payloads[0];
  assert.equal(withExtras.premium_estimate, 8400);
  assert.equal(withExtras.carrier, "Progressive");
});

test("server-derived and read-only fields are never sent", () => {
  const { payloads } = toOpportunityPayloads(crmBundle({ extraFields: { stage: "Quoting", probability: 50 } }));
  for (const forbidden of ["stage", "probability", "likelihood", "referral_source", "client_identifier", "approved_by"]) {
    assert.ok(!(forbidden in payloads[0]), `${forbidden} must never be sent`);
  }
  assert.equal(payloads[0].source, OPPORTUNITY_SOURCE);
});

test("an opportunity with no line of business is skipped with a reason, not guessed", () => {
  const bundle = crmBundle();
  bundle.crm_records[0].fields = [];
  bundle.crm_records[0].needs_review = [{ field: "line_of_business", reason: "MISSING" }];
  const { payloads, skipped } = toOpportunityPayloads(bundle);
  assert.equal(payloads.length, 0);
  assert.equal(skipped[0].reason, "NO_LINE_OF_BUSINESS");
});

test("buildProvenance degrades gracefully with no source", () => {
  assert.equal(buildProvenance(), "Source: RSG intake gate.");
});

// --- fan-out ---------------------------------------------------------------

const okClient = (results) => {
  let call = 0;
  return { createOpportunity: async () => results[call++] };
};

test("the writer is off unless the flag is set", async () => {
  const report = await writeOpportunities(crmBundle(), { client: okClient([]), enabled: false });
  assert.equal(report.status, CrmWriteStatus.DISABLED);
  assert.equal(report.attempted, 0);
});

test("created:false is adopted, never a failure", async () => {
  const client = okClient([
    { ok: true, created: true, opportunity: { id: "o1" } },
    { ok: true, created: false, opportunity: { id: "o2" } },
  ]);
  const report = await writeOpportunities(crmBundle({ lobs: ["General Liability", "Worker's Compensation"] }), { client, enabled: true });
  assert.equal(report.created, 1);
  assert.equal(report.adopted, 1);
  assert.deepEqual(report.failed, []);
});

test("partial success keeps the successes", async () => {
  let call = 0;
  const client = {
    createOpportunity: async () => {
      call += 1;
      if (call === 2) throw Object.assign(new Error("Unknown opportunity_type"), { statusCode: 400 });
      return { ok: true, created: true, opportunity: { id: `o${call}` } };
    },
  };
  const report = await writeOpportunities(crmBundle({ lobs: ["General Liability", "Worker's Compensation", "Commercial Property"] }), { client, enabled: true });
  assert.equal(report.attempted, 3);
  assert.equal(report.created, 2, "two successes must not be rolled back");
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].status, 400);
  assert.match(report.failed[0].detail, /Unknown opportunity_type/, "Hermes' detail must be surfaced, not swallowed");
});

test("a total Hermes outage reports failures rather than throwing", async () => {
  const client = { createOpportunity: async () => { throw new Error("connect ECONNREFUSED"); } };
  const report = await writeOpportunities(crmBundle({ lobs: ["General Liability", "Homeowners"] }), { client, enabled: true });
  assert.equal(report.status, CrmWriteStatus.COMPLETE);
  assert.equal(report.created, 0);
  assert.equal(report.failed.length, 2);
  assert.match(report.failed[0].detail, /ECONNREFUSED/);
});

test("no configured client reports NOT_CONFIGURED instead of crashing", async () => {
  const report = await writeOpportunities(crmBundle(), { client: null, enabled: true });
  assert.equal(report.status, CrmWriteStatus.NOT_CONFIGURED);
});
