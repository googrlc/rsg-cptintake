// Read a driver's licence from a photograph of the back of the card.
//
// Decode-then-parse: the PDF417 symbol carries the cardholder's details as
// structured AAMVA text, so this is exact rather than recognition-based. OCR is
// never used to obtain licence fields — a misread digit in a licence number or
// date of birth is worse than no value at all, and the front of the card offers
// no way to detect that it happened.
//
// Everything returned is SUGGESTED. Licence data reaches the AMS only through
// the normal contract routing and human approval, exactly like every other
// field.

import { decodeBarcodes, BarcodeReason } from "./barcode.js";
import { parseAamva, aamvaToContactFields } from "./aamva.js";

export const LicenseStatus = {
  READ: "READ",
  NO_BARCODE: "NO_BARCODE",
  NOT_A_LICENSE: "NOT_A_LICENSE",
  UNAVAILABLE: "UNAVAILABLE",
};

/**
 * @param {Buffer} bytes raw image bytes (back of the licence)
 * @param {object} [options]
 * @param {number} [options.contactIndex] which Contact[n] slot to populate
 * @returns {Promise<{status: string, ok: boolean, message: string,
 *   fields?: object, contact_fields?: object[], warnings: string[]}>}
 */
export async function readDriverLicense(bytes, { contactIndex = 1, decode = decodeBarcodes } = {}) {
  const decoded = await decode(bytes, { formats: ["PDF417"] });
  if (!decoded.ok) {
    const status = decoded.reason === BarcodeReason.NOT_AVAILABLE ? LicenseStatus.UNAVAILABLE : LicenseStatus.NO_BARCODE;
    return {
      status,
      ok: false,
      message:
        status === LicenseStatus.NO_BARCODE
          ? "No PDF417 barcode found. Photograph the BACK of the licence, filling the frame, with even lighting and no glare."
          : decoded.message,
      warnings: [],
    };
  }

  // A card may carry more than one symbol; take the first that parses as AAMVA
  // rather than assuming the first symbol is the licence.
  const failures = [];
  for (const symbol of decoded.symbols) {
    const parsed = parseAamva(symbol);
    if (!parsed.ok) {
      failures.push(parsed.message);
      continue;
    }
    return {
      status: LicenseStatus.READ,
      ok: true,
      message: "Driver's licence read from the barcode. Confirm the values against the card before approving.",
      fields: parsed.fields,
      standard: parsed.standard,
      contact_fields: aamvaToContactFields(parsed.fields, contactIndex),
      warnings: parsed.warnings,
    };
  }

  return {
    status: LicenseStatus.NOT_A_LICENSE,
    ok: false,
    message: `A barcode was found but it is not an AAMVA driver's licence. ${failures[0] ?? ""}`.trim(),
    warnings: [],
  };
}
