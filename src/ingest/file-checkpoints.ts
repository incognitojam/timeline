import type { Database } from "../db/sqlite";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

// Files can be rewritten within one ctime tick (the git "racy clean" case).
// Hash recent inputs as well; old, stable logs need only stat. Use --full on
// filesystems that do not maintain stat metadata reliably.
const RACY_WINDOW_NS = 2_000_000_000n;
export async function fileFingerprint(path: string): Promise<string | null> {
  try {
    const s = await stat(path, { bigint: true });
    let hash = "";
    if (BigInt(Date.now()) * 1_000_000n - s.ctimeNs <= RACY_WINDOW_NS) {
      const hasher = new Bun.CryptoHasher("sha256");
      for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
      hash = hasher.digest("hex");
    }
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, hash].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function initFileCheckpoints(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS file_import_checkpoints (
    source TEXT NOT NULL, account TEXT NOT NULL, root TEXT NOT NULL,
    path TEXT NOT NULL, version INTEGER NOT NULL, fingerprint TEXT NOT NULL,
    dependencies TEXT NOT NULL, metadata TEXT NOT NULL,
    PRIMARY KEY (source, account, root, path)
  );
  CREATE TABLE IF NOT EXISTS file_import_epochs (
    source TEXT NOT NULL, account TEXT NOT NULL, epoch INTEGER NOT NULL,
    PRIMARY KEY (source, account)
  );`);
}

export interface FileCheckpoint {
  path: string;
  version: number;
  fingerprint: string;
  dependencies: string;
  metadata: string;
}

/** Kept with events so restoring/replacing the database also restores its progress.
 * Deleting source events invalidates its checkpoints; --full bypasses them.
 * Queue save after all file writes, in the same or a later transaction, and
 * only after checking that inputs stayed stable throughout preparation.
 */
export function fileCheckpoints(db: Database, source: string, account: string, root: string) {
  const scope = [source, account, resolve(root)];
  const epochQuery = db.prepare("SELECT epoch FROM file_import_epochs WHERE source = ? AND account = ?");
  const epoch = () => (epochQuery.get(source, account) as { epoch: number } | null)?.epoch ?? 0;
  const startingEpoch = epoch();
  const rows = db.prepare(`SELECT path, version, fingerprint, dependencies, metadata
    FROM file_import_checkpoints WHERE source = ? AND account = ? AND root = ?`).all(...scope) as FileCheckpoint[];
  const saved = new Map(rows.map(row => [row.path, row]));
  return {
    saved,
    save(row: FileCheckpoint) {
      // This executes inside the writer transaction. A deletion after the
      // read-only comparison must not be hidden by a later queued checkpoint.
      if (epoch() !== startingEpoch) return;
      db.prepare(`INSERT INTO file_import_checkpoints
        (source, account, root, path, version, fingerprint, dependencies, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source, account, root, path) DO UPDATE SET
          version = excluded.version, fingerprint = excluded.fingerprint,
          dependencies = excluded.dependencies, metadata = excluded.metadata`)
        .run(...scope, row.path, row.version, row.fingerprint, row.dependencies, row.metadata);
    },
    remove(path: string) {
      db.prepare(`DELETE FROM file_import_checkpoints
        WHERE source = ? AND account = ? AND root = ? AND path = ?`).run(...scope, path);
    },
  };
}
