import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Private short-retention scratch store for accepted PDF uploads. Files live in
// a 0700 directory with 0600 permissions and a sidecar metadata record. This is
// the local stand-in for the Azure Blob container described in the plan; the
// interface (put/get/purge/sweep) is what the Blob adapter must satisfy later.
//
// Never place raw bytes in logs. Retention is measured against accepted_at and
// the sweep() method deletes anything past its TTL.

export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for un-committed uploads

export class TempDocumentStore {
  constructor(dir, { ttlMs = DEFAULT_TTL_MS } = {}) {
    this.dir = path.resolve(dir);
    this.ttlMs = ttlMs;
  }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  #paths(documentId) {
    if (!/^[a-f0-9-]{36}$/.test(documentId)) throw new Error("Invalid document id.");
    return {
      blob: path.join(this.dir, `${documentId}.pdf`),
      meta: path.join(this.dir, `${documentId}.json`),
    };
  }

  // Store accepted bytes plus the intake metadata. Atomic via temp+rename.
  async put(buffer, metadata) {
    await this.init();
    const { blob, meta } = this.#paths(metadata.document_id);
    const tmp = `${blob}.${randomUUID()}.tmp`;
    await writeFile(tmp, buffer, { mode: 0o600 });
    await rename(tmp, blob);
    await writeFile(meta, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    return { ...metadata, stored_path: blob };
  }

  async getMetadata(documentId) {
    try {
      return JSON.parse(await readFile(this.#paths(documentId).meta, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async getBytes(documentId) {
    try {
      return await readFile(this.#paths(documentId).blob);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async purge(documentId) {
    const { blob, meta } = this.#paths(documentId);
    await rm(blob, { force: true });
    await rm(meta, { force: true });
  }

  // Delete any stored document whose age exceeds ttlMs. Returns purged IDs.
  // `now` is injectable so tests need not wait real time.
  async sweep(now = Date.now()) {
    await this.init();
    const purged = [];
    const files = (await readdir(this.dir)).filter((name) => name.endsWith(".json"));
    for (const name of files) {
      const documentId = name.replace(/\.json$/, "");
      const meta = await this.getMetadata(documentId).catch(() => null);
      const acceptedAt = meta?.accepted_at ? Date.parse(meta.accepted_at) : null;
      const fallbackMtime = acceptedAt ?? (await stat(path.join(this.dir, name))).mtimeMs;
      if (now - fallbackMtime > this.ttlMs) {
        await this.purge(documentId);
        purged.push(documentId);
      }
    }
    return purged;
  }
}
