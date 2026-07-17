import { parsedIntakeSchema } from "./intake-schema.js";

// Parser interface for the "Parse intake" action. The live implementation
// (OpenAI/Anthropic structured output over the free-text assessment) is
// deferred; it must return an object conforming to parsedIntakeSchema. This
// keeps the intake pipeline testable and prevents parsing from ever reaching a
// writer directly.
//
// @typedef {{ parse(input: {raw_text: string, submitted_by: string}): Promise<object> }} IntakeParser

// Deterministic offline parser. Returns a pre-registered parsed intake keyed by
// the exact raw_text. Used by tests and shadow runs — no model call, no key.
export class StubIntakeParser {
  constructor(fixtures = {}) {
    this.byText = new Map(Object.entries(fixtures));
  }

  register(rawText, parsed) {
    this.byText.set(rawText, parsed);
  }

  async parse({ raw_text: rawText, submitted_by: submittedBy }) {
    const seed = this.byText.get(rawText);
    if (!seed) throw new Error("No stub intake registered for the supplied text.");
    const merged = { ...seed, raw_text: rawText, submitted_by: submittedBy };
    // Validate the parser's own output so a malformed stub fails loudly rather
    // than flowing bad shapes downstream.
    return parsedIntakeSchema.parse(merged);
  }
}
