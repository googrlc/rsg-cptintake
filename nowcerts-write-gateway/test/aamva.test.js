import test from "node:test";
import assert from "node:assert/strict";
import { parseAamva, parseAamvaDate, aamvaToContactFields, AamvaReason } from "../src/documents/aamva.js";
import { readDriverLicense, LicenseStatus } from "../src/documents/license-intake.js";
import { samplePayload } from "./fixtures.js";

test("a licence payload parses into exact cardholder fields", () => {
  const result = parseAamva(samplePayload());
  assert.equal(result.ok, true);
  assert.equal(result.fields.first_name, "JANE");
  assert.equal(result.fields.last_name, "UKOH");
  assert.equal(result.fields.middle_name, "M");
  assert.equal(result.fields.license_number, "059123456");
  assert.equal(result.fields.state, "GA");
  assert.equal(result.fields.city, "MARIETTA");
  assert.equal(result.fields.sex, "F");
  assert.equal(result.standard.aamva_version, "09");
});

test("AAMVA MMDDCCYY dates convert to ISO", () => {
  const result = parseAamva(samplePayload());
  assert.equal(result.fields.date_of_birth, "1955-04-02");
  assert.equal(result.fields.license_expiry, "2028-08-31");
  assert.equal(result.fields.license_issued, "2024-08-31");
});

test("Canadian CCYYMMDD dates are read in the other order", () => {
  const { value } = parseAamvaDate("19550402", "CAN");
  assert.equal(value, "1955-04-02");
  assert.equal(parseAamvaDate("04021955", "USA").value, "1955-04-02");
});

test("an impossible date is reported rather than coerced", () => {
  assert.equal(parseAamvaDate("13991999").value, null);
  assert.match(parseAamvaDate("13991999").warning, /Unrecognized date/);
  assert.equal(parseAamvaDate("").value, null);
});

test("the two AAMVA date encodings can never both be valid, so no tie-break is needed", () => {
  // MMDDCCYY requires digits 1-2 to be a month (01-12), which caps the first
  // four digits at 1299 — below the 1900 floor CCYYMMDD requires for a year.
  // This is what lets parseAamvaDate resolve without guessing. Exhaustive check.
  const ok = (y, m, d) => {
    const probe = new Date(Date.UTC(y, m - 1, d));
    return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 &&
      probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  };
  for (let n = 0; n < 100_000_000; n += 7919) {
    const s = String(n).padStart(8, "0");
    const mdy = ok(+s.slice(4, 8), +s.slice(0, 2), +s.slice(2, 4));
    const ymd = ok(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
    assert.ok(!(mdy && ymd), `${s} parsed as a valid date under both encodings`);
  }
});

test("AAMVA no-data sentinels never become field values", () => {
  const result = parseAamva(samplePayload({ DAD: "NONE", DAG: "UNAVL" }));
  assert.equal(result.ok, true);
  assert.equal(result.fields.middle_name, undefined);
  assert.equal(result.fields.address_line1, undefined);
});

test("a nine-digit ZIP renders as ZIP or ZIP+4", () => {
  assert.equal(parseAamva(samplePayload()).fields.postal_code, "30062");
  assert.equal(parseAamva(samplePayload({ DAK: "300621234" })).fields.postal_code, "30062-1234");
});

test("a non-licence payload is refused rather than parsed", () => {
  const result = parseAamva("https://example.test/not-a-licence");
  assert.equal(result.ok, false);
  assert.equal(result.reason, AamvaReason.NOT_AAMVA);
});

test("a missing licence number or DOB is surfaced as a warning", () => {
  const result = parseAamva(samplePayload({ DAQ: null, DBB: null }));
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some((w) => /licence number/.test(w)));
  assert.ok(result.warnings.some((w) => /date of birth/.test(w)));
});

test("parsed fields map onto contracted Contact.* keys", () => {
  const { fields } = parseAamva(samplePayload());
  const mapped = aamvaToContactFields(fields, 2);
  const byField = Object.fromEntries(mapped.map((m) => [m.field, m.value]));
  assert.equal(byField["Contact[2].FirstName"], "JANE");
  assert.equal(byField["Contact[2].LastName"], "UKOH");
  assert.equal(byField["Contact[2].DOB"], "1955-04-02");
  assert.equal(byField["Contact[2].LicenseNumber"], "059123456");
  assert.equal(byField["Contact[2].LicenseState"], "GA");
  // Address and physical description are not contracted, so they must not leak
  // into the AMS routing payload.
  assert.ok(!mapped.some((m) => /Address|Sex|Height|Eye/i.test(m.field)));
});

test("no barcode in the image yields actionable operator guidance", async () => {
  const result = await readDriverLicense(Buffer.from("not an image"), {
    decode: async () => ({ ok: false, reason: "NO_BARCODE", message: "none", symbols: [] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, LicenseStatus.NO_BARCODE);
  assert.match(result.message, /BACK of the licence/);
});

test("a decoded non-AAMVA barcode is not treated as a licence", async () => {
  const result = await readDriverLicense(Buffer.alloc(1), {
    decode: async () => ({ ok: true, symbols: ["SHIPPING-MANIFEST-99"] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, LicenseStatus.NOT_A_LICENSE);
});

test("the first AAMVA symbol wins when a card carries several barcodes", async () => {
  const result = await readDriverLicense(Buffer.alloc(1), {
    decode: async () => ({ ok: true, symbols: ["INVENTORY-TAG", samplePayload()] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.fields.last_name, "UKOH");
  // First, last, middle, DOB, licence number, licence state.
  assert.equal(result.contact_fields.length, 6);
});

test("an unavailable decoder is reported, never silently skipped", async () => {
  const result = await readDriverLicense(Buffer.alloc(1), {
    decode: async () => ({ ok: false, reason: "NOT_AVAILABLE", message: "decoder missing", symbols: [] }),
  });
  assert.equal(result.status, LicenseStatus.UNAVAILABLE);
});
