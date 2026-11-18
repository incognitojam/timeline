import { Database } from "../../src/db/sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { SQLITE_PIN } from "../../src/db/sqlite-pin";
import { assertSqlitePin } from "../../src/db/sqlite-runtime";

const root = resolve(import.meta.dir, "../..");
// Bump when compiler, linker or strip flags outside the pinned defines change.
const revision = 1;
export function buildTarget(arch = process.arch): string {
  if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported macOS architecture ${arch}`);
  return `${arch === "x64" ? "x86_64" : arch}-apple-macos14.0`;
}
export function buildId(arch = process.arch, pin = SQLITE_PIN): string {
  const target = buildTarget(arch);
  const input = JSON.stringify([pin.source.sha256, Object.entries(pin.defines).sort(), target, revision]);
  return `sqlite-${pin.version}-${createHash("sha256").update(input).digest("hex").slice(0, 12)}`;
}
export function verifySource(source: Uint8Array, expected = SQLITE_PIN.source.sha256): void {
  const actual = createHash("sha256").update(source).digest("hex");
  if (actual !== expected) throw new Error(`SQLite source sha256 mismatch: expected ${expected}, got ${actual}. Remove the cached source and retry bun run sqlite:build; do not compile unverified bytes.`);
}
function run(args: string[]): void {
  const result = Bun.spawnSync(args, { stdout: 2, stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed (${result.exitCode})`);
}
export async function ensureSqliteLibrary(): Promise<string | null> {
  if (process.platform === "linux") {
    using db = new Database(":memory:");
    assertSqlitePin(db);
    return null;
  }
  if (process.platform !== "darwin") throw new Error("sqlite:build supports Linux and macOS only");
  if (process.arch !== "arm64" && process.arch !== "x64") throw new Error(`Unsupported macOS architecture ${process.arch}`);
  const directory = join(root, ".cache/sqlite", buildId());
  const library = join(directory, "libsqlite3.dylib");
  if (await Bun.file(library).exists()) {
    try {
      run([process.execPath, "--no-env-file", resolve(import.meta.dir, "verify-library.ts"), library]);
    } catch (cause) {
      throw new Error(`Cached SQLite failed verification. Remove ${directory} and rerun bun run sqlite:build.`, { cause });
    }
    return library;
  }
  const sourceDir = join(root, ".cache/sqlite/src");
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = join(sourceDir, `${SQLITE_PIN.source.sha256}.c`);
  if (!(await Bun.file(sourcePath).exists())) {
    const response = await fetch(SQLITE_PIN.source.url);
    if (!response.ok) throw new Error(`Downloading SQLite: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    verifySource(bytes);
    const temporary = `${sourcePath}.${crypto.randomUUID()}.tmp`;
    await Bun.write(temporary, bytes);
    await rename(temporary, sourcePath);
  }
  verifySource(await readFile(sourcePath));
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${crypto.randomUUID()}.dylib`);
  try {
    run(["cc", "-O2", "-DNDEBUG", "-fPIC", "-dynamiclib", "-target", buildTarget(), "-install_name", "@rpath/libsqlite3.dylib", ...Object.entries(SQLITE_PIN.defines).map(([key, value]) => `-D${key}=${value}`), sourcePath, "-o", temporary]);
    run(["strip", "-x", temporary]);
    // Validate in a fresh process: selecting a library is process-global on macOS.
    run([process.execPath, "--no-env-file", resolve(import.meta.dir, "verify-library.ts"), temporary]);
    await rename(temporary, library);
  } finally { await rm(temporary, { force: true }); }
  return library;
}
if (import.meta.main) console.log(await ensureSqliteLibrary() ?? "Linux: Bun's built-in SQLite matches the pin");
