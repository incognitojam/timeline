import { cpSync, existsSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Marks a media/ directory as the seed's, so only seeded media is ever replaced. */
export const SEED_MEDIA_MARKER = ".timeline-seed";

/** Databases the seed replaces; embeddings.db is removed because its vectors index the old events. */
const DATABASES = ["timeline.db", "app-state.db"] as const;
const STALE_DATABASES = ["embeddings.db"] as const;
const SQLITE_SIDECARS = ["-wal", "-shm"] as const;

/**
 * Refuse an output directory that is the Timeline host's data directory, where
 * the seed would replace the live timeline.db, app-state.db, and embeddings.db.
 * Compares real paths, so a symlinked --out cannot alias it, and ignores case
 * where the filesystem usually does (macOS, Windows).
 */
export function assertNotHostDataDir(outDir: string, hostDbPath: string): void {
  const canonical = (path: string) => {
    const real = existsSync(path) ? realpathSync(path) : resolve(path);
    return process.platform === "darwin" || process.platform === "win32" ? real.toLowerCase() : real;
  };
  if (canonical(outDir) === canonical(dirname(hostDbPath))) {
    throw new Error(`Refusing to seed into ${outDir}: it holds the Timeline host database (${hostDbPath})`);
  }
}

/**
 * Refuse to replace a media/ directory the seed did not create.
 */
export function assertReplaceableMedia(outDir: string): void {
  const media = join(outDir, "media");
  if (existsSync(media) && !existsSync(join(media, SEED_MEDIA_MARKER))) {
    throw new Error(`${media} exists and was not created by the seed; move it aside first`);
  }
}

/**
 * Move a finished build (timeline.db, app-state.db, media/) into outDir.
 *
 * Everything is first moved or copied next to its destination under a
 * temporary name; only once all of it is there are the old files replaced by
 * same-filesystem renames. A failure while staging (ENOSPC, permissions)
 * removes the staged copies and leaves the previous seed untouched.
 */
export function installBuild(buildDir: string, outDir: string): void {
  const items = [...DATABASES, "media"];
  const staged = (name: string) => join(outDir, `.seed-new-${name}`);
  const removeStaged = () => {
    for (const name of items) rmSync(staged(name), { recursive: true, force: true });
  };
  removeStaged();
  try {
    for (const name of items) moveAcross(join(buildDir, name), staged(name));
  } catch (error) {
    // Includes a copy that failed partway through.
    removeStaged();
    throw error;
  }

  for (const name of [...DATABASES, ...STALE_DATABASES]) {
    for (const suffix of SQLITE_SIDECARS) rmSync(join(outDir, name + suffix), { force: true });
  }
  for (const name of STALE_DATABASES) rmSync(join(outDir, name), { force: true });
  for (const name of DATABASES) renameSync(staged(name), join(outDir, name));

  const media = join(outDir, "media");
  const previous = join(outDir, ".seed-old-media");
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(media)) renameSync(media, previous);
  renameSync(staged("media"), media);
  rmSync(previous, { recursive: true, force: true });
}

/** Rename, or copy then delete when the build lives on another filesystem. */
function moveAcross(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}
