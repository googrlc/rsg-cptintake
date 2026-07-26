// AAMVA DL/ID barcode payload parser.
//
// Every US and Canadian driver's licence carries a PDF417 barcode on the back
// encoding the cardholder's details as structured text under the AAMVA DL/ID
// Card Design Standard. Decoding it is exact — unlike OCR of the printed front,
// there is no character-confidence step and no chance of reading 8 as B.
//
// This module is pure and dependency-free: bytes in, fields out. It never
// guesses. An element that is absent, blank, or filled with an AAMVA "no data"
// sentinel (NONE / UNAVL / U) is omitted rather than defaulted, and anything it
// cannot parse is reported as a warning for human review.
//
// Reference: AAMVA DL/ID Card Design Standard, data element definitions.

const LF = "\n";
const CR = "\r";
const RS = "\x1e"; // record separator (0x1e)
const CS = "@"; // compliance indicator

// The subset of AAMVA elements RSG has a use for. Deliberately narrow — we do
// not extract or retain more PII than the intake actually needs.
const ELEMENTS = {
  DCS: "last_name",
  DAC: "first_name",
  DAD: "middle_name",
  DBB: "date_of_birth",
  DBA: "license_expiry",
  DBD: "license_issued",
  DAQ: "license_number",
  DAG: "address_line1",
  DAI: "city",
  DAJ: "state",
  DAK: "postal_code",
  DBC: "sex",
  DCG: "country",
  DAA: "full_name", // legacy combined name (AAMVA < v2)
};

const DATE_FIELDS = new Set(["date_of_birth", "license_expiry", "license_issued"]);

// AAMVA uses these to mean "the card does not carry this value". Treating them
// as data would write the literal string "NONE" into a client record.
const NO_DATA = new Set(["NONE", "UNAVL", "UNKNOWN", "U", "NA", "N/A", ""]);

const SEX = { 1: "M", 2: "F", 9: "X" };

export const AamvaReason = {
  NOT_AAMVA: "NOT_AAMVA",
  NO_ELEMENTS: "NO_ELEMENTS",
};

// AAMVA dates are MMDDCCYY in the US and CCYYMMDD in Canada. Both orderings are
// tried and the one yielding a real calendar date wins.
//
// The two encodings can never both be valid, so this needs no tie-break and no
// guess: MMDDCCYY requires the first two digits to be a month (01-12), which
// forces the first four digits below 1300 — outside the 1900-2100 year range
// CCYYMMDD requires. The country element is still honoured when present so the
// correct reading is tried first. See the invariant test in aamva.test.js.
export function parseAamvaDate(raw, country = null) {
  const text = String(raw ?? "").trim();
  if (!/^\d{8}$/.test(text)) return { value: null, warning: text ? `Unrecognized date "${text}".` : null };

  const asMdy = toIso(text.slice(4, 8), text.slice(0, 2), text.slice(2, 4));
  const asYmd = toIso(text.slice(0, 4), text.slice(4, 6), text.slice(6, 8));
  const value = country === "CAN" ? (asYmd ?? asMdy) : (asMdy ?? asYmd);

  return { value, warning: value ? null : `Unrecognized date "${text}".` };
}

function toIso(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!(y >= 1900 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function clean(value) {
  const text = String(value ?? "").trim();
  return NO_DATA.has(text.toUpperCase()) ? null : text;
}

/**
 * Parse a decoded AAMVA barcode payload into contact fields.
 *
 * @param {string} payload raw text decoded from the PDF417 symbol
 * @returns {{ok: boolean, reason?: string, message?: string, fields?: object, warnings: string[]}}
 */
export function parseAamva(payload) {
  const text = String(payload ?? "");
  const warnings = [];

  // The compliance indicator and "ANSI "/"AAMVA" file type mark a DL/ID payload.
  // Without them this is some other barcode and must not be read as a licence.
  if (!text.startsWith(CS) && !/^\s*(ANSI|AAMVA)\s/.test(text)) {
    return { ok: false, reason: AamvaReason.NOT_AAMVA, message: "Not an AAMVA DL/ID barcode payload.", warnings };
  }

  const header = /(ANSI|AAMVA)\s*(\d{6})(\d{2})/.exec(text);
  const issuerIdentificationNumber = header?.[2] ?? null;
  const aamvaVersion = header?.[3] ?? null;

  // Elements are 3-character identifiers followed by their value, delimited by
  // LF, CR, or RS depending on issuer. Split on all three rather than assuming.
  const raw = {};
  for (const segment of text.split(new RegExp("[\\n\\r\\x1e]+"))) {
    const match = /^([A-Z]{3})(.*)$/s.exec(segment.trim());
    if (match) raw[match[1]] = match[2];
  }
  // The first subfile's leading element is prefixed by the "DL"/"ID" subfile
  // type, which the split above leaves attached (e.g. "DLDCAC" -> DCA = "C").
  for (const [key, value] of Object.entries(raw)) {
    const nested = /^(?:DL|ID)([A-Z]{3})(.*)$/s.exec(`${key}${value}`);
    if (nested && !raw[nested[1]]) raw[nested[1]] = nested[2];
  }

  const country = clean(raw.DCG);
  const fields = {};
  for (const [code, name] of Object.entries(ELEMENTS)) {
    const value = clean(raw[code]);
    if (value === null) continue;
    if (DATE_FIELDS.has(name)) {
      const { value: iso, warning } = parseAamvaDate(value, country);
      if (warning) warnings.push(warning);
      if (iso) fields[name] = iso;
      continue;
    }
    fields[name] = value;
  }

  if (fields.sex) fields.sex = SEX[Number(fields.sex)] ?? null;
  if (fields.sex === null) delete fields.sex;
  // ZIP arrives zero-padded to 9 characters; render as ZIP or ZIP+4.
  if (fields.postal_code) fields.postal_code = formatPostal(fields.postal_code);

  // A legacy combined name is split only when the discrete elements are absent,
  // and only when it splits unambiguously.
  if (fields.full_name && !fields.last_name && !fields.first_name) {
    const parts = fields.full_name.split(/\s*,\s*|\s+/).filter(Boolean);
    if (parts.length >= 2) {
      fields.last_name = parts[0];
      fields.first_name = parts[1];
      if (parts.length > 2) fields.middle_name = parts.slice(2).join(" ");
      warnings.push(`Name was split from the combined DAA element ("${fields.full_name}"); confirm against the card.`);
    }
  }
  delete fields.full_name;

  if (Object.keys(fields).length === 0) {
    return { ok: false, reason: AamvaReason.NO_ELEMENTS, message: "No readable AAMVA data elements.", warnings };
  }
  if (!fields.license_number) warnings.push("Barcode carried no licence number (DAQ).");
  if (!fields.date_of_birth) warnings.push("Barcode carried no date of birth (DBB).");

  return {
    ok: true,
    fields,
    standard: { issuer_identification_number: issuerIdentificationNumber, aamva_version: aamvaVersion },
    warnings,
  };
}

function formatPostal(value) {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length === 9) return digits.slice(5) === "0000" ? digits.slice(0, 5) : `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return String(value).trim();
}

/**
 * Map parsed AAMVA fields onto the indexed Contact.* keys the routing layer
 * understands. Only fields with a certified AMS contract are emitted; the rest
 * stay on the report.
 */
export function aamvaToContactFields(fields, index = 1) {
  const prefix = `Contact[${index}]`;
  const mapped = [
    [`${prefix}.FirstName`, fields.first_name],
    [`${prefix}.LastName`, fields.last_name],
    [`${prefix}.MiddleName`, fields.middle_name],
    [`${prefix}.DOB`, fields.date_of_birth],
    [`${prefix}.LicenseNumber`, fields.license_number],
    [`${prefix}.LicenseState`, fields.state],
  ];
  return mapped.filter(([, value]) => value != null && value !== "").map(([field, value]) => ({ field, value }));
}
