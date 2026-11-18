/**
 * Whether tests that need sqlite-vec skip on this machine. macOS's system
 * SQLite cannot load extensions, so there they need TIMELINE_SQLITE_LIBRARY_PATH
 * (test.sh sets it from Homebrew's SQLite when installed). Elsewhere bun:sqlite
 * loads sqlite-vec, so a failure to load it fails those tests instead.
 */
export const skipWithoutSqliteVec = process.platform === "darwin" && !process.env.TIMELINE_SQLITE_LIBRARY_PATH;
