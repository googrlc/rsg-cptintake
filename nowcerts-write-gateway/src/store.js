import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { RecordCipher } from "./storage/record-cipher.js";

export class FileProposalStore {
  // Proposals carry the cited client payload, so they are encrypted at rest when
  // a key is configured. The audit log is deliberately NOT encrypted: it records
  // ids, statuses, and fingerprints rather than client data, and it has to stay
  // greppable for incident review.
  constructor(dataDir, cipher = RecordCipher.fromEnv()) {
    this.dataDir = path.resolve(dataDir);
    this.proposalDir = path.join(this.dataDir, "proposals");
    this.auditPath = path.join(this.dataDir, "audit.jsonl");
    this.cipher = cipher;
  }

  async init() {
    await mkdir(this.proposalDir, { recursive: true, mode: 0o700 });
  }

  proposalPath(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid proposal id.");
    return path.join(this.proposalDir, `${id}.json`);
  }

  async save(record) {
    await this.init();
    const destination = this.proposalPath(record.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, this.cipher.serialize(record), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, destination);
    return record;
  }

  async get(id) {
    try {
      return this.cipher.deserialize(await readFile(this.proposalPath(id), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async list() {
    await this.init();
    const names = (await readdir(this.proposalDir)).filter((name) => name.endsWith(".json"));
    return Promise.all(
      names.map(async (name) =>
        this.cipher.deserialize(await readFile(path.join(this.proposalDir, name), "utf8")),
      ),
    );
  }

  async activeForTarget(databaseId) {
    if (!databaseId) return [];
    const inactive = new Set(["SHADOW_APPROVED", "CANCELLED", "SUPERSEDED"]);
    return (await this.list()).filter(
      (record) =>
        record.proposal?.target?.database_id === databaseId && !inactive.has(record.status),
    );
  }

  async audit(event) {
    await this.init();
    const safeEvent = {
      at: new Date().toISOString(),
      ...event,
    };
    await appendFile(this.auditPath, `${JSON.stringify(safeEvent)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
