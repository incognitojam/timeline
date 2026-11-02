import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const toolchain = resolve(import.meta.dir, "toolchain.sh");

function requirePinnedBun(packageJson: object, activeVersion: string) {
  const directory = mkdtempSync(join(tmpdir(), "timeline-toolchain-test-"));
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify(packageJson));
    mkdirSync(join(directory, "bin"));
    writeFileSync(join(directory, "bin", "bun"), [
      "#!/usr/bin/env bash",
      'if [ "$1" = --version ]; then echo "$FAKE_BUN_VERSION"; else exec "$REAL_BUN" "$@"; fi',
    ].join("\n"), { mode: 0o755 });
    const result = Bun.spawnSync(["bash", "-c", `source "${toolchain}" && require_pinned_bun`], {
      cwd: directory,
      env: {
        PATH: `${join(directory, "bin")}:/usr/bin:/bin`,
        REAL_BUN: process.execPath,
        FAKE_BUN_VERSION: activeVersion,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("require_pinned_bun", () => {
  test("accepts the Bun version pinned by packageManager", () => {
    expect(requirePinnedBun({ packageManager: "bun@1.3.14" }, "1.3.14").exitCode).toBe(0);
  });

  test("accepts a pin carrying a Corepack checksum", () => {
    expect(requirePinnedBun({ packageManager: "bun@1.3.14+sha224.abc" }, "1.3.14").exitCode).toBe(0);
  });

  test("rejects a different active Bun with both versions and a remedy", () => {
    const result = requirePinnedBun({ packageManager: "bun@1.3.14" }, "1.4.2");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("requires Bun 1.3.14");
    expect(result.output).toContain("is Bun 1.4.2");
    expect(result.output).toContain("mise install");
  });

  test("rejects a package.json without a Bun pin", () => {
    const result = requirePinnedBun({}, "1.3.14");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("must pin an exact bun@<version>");
  });
});
