import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export class FileIntakeSourceStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
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
    await writeFile(temporary, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    return bundle;
  }

  async get(intakeId) {
    try {
      return JSON.parse(await readFile(this.#path(intakeId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
}

