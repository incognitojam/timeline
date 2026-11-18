import type { Database } from "../db/sqlite";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export const CHECKPOINT_SOURCES = ["codex", "claude-code"] as const;
type CheckpointSource = (typeof CHECKPOINT_SOURCES)[number];

// Do not checkpoint timestamps that may still share a filesystem clock tick.
export const CHECKPOINT_QUIET_WINDOW_MS = 2_000;
export interface FileFingerprint {
  value: string;
  checkpointable: boolean;
}

export async function fileFingerprint(path: string): Promise<FileFingerprint | null> {
  try {
    const s = await stat(path, { bigint: true });
    const quietBefore = BigInt(Date.now() - CHECKPOINT_QUIET_WINDOW_MS) * 1_000_000n;
    return {
      value: [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":"),
      checkpointable: s.mtimeNs < quietBefore && s.ctimeNs < quietBefore,
    };
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
 * Queue save after all file writes, in the same or a later transaction, using the
 * pre-read fingerprint; fresh inputs and dependencies must not be checkpointed.
 */
export function fileCheckpoints(db: Database, source: CheckpointSource, account: string, root: string) {
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
