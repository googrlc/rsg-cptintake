import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { RecordCipher } from "../storage/record-cipher.js";

export class FileIntakeSourceStore {
  // Intake bundles hold the full cited source text — the most PII-dense records
  // the gateway retains — so they are encrypted at rest when a key is set.
  constructor(dir, cipher = RecordCipher.fromEnv()) {
    this.dir = path.resolve(dir);
    this.cipher = cipher;
  }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  #path(intakeId) {
    if (!/^[a-f0-9-]{36}$/.test(intakeId)) throw new Error("Invalid intake id.");
    return path.join(this.dir, `${intakeId}.json`);
  }

  async save(bundle) {
    await this.init();
    const target = this.#path(bundle.intake_id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, this.cipher.serialize(bundle), { mode: 0o600 });
    await rename(temporary, target);
    return bundle;
  }

  async get(intakeId) {
    try {
      return this.cipher.deserialize(await readFile(this.#path(intakeId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
}

