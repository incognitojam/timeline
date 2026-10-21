import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const decoder = new TextDecoder();

function git(
  args: string[],
  options: { index?: string; stdin?: string } = {},
): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    env: options.index
      ? { ...process.env, GIT_INDEX_FILE: options.index }
      : process.env,
    stdin: options.stdin === undefined ? undefined : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(decoder.decode(result.stderr));
  }
  return decoder.decode(result.stdout).trim();
}

function createIndex(directory: string): string {
  const index = join(directory, "index");
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  git(["read-tree", tree], { index });
  return index;
}

function addBlob(index: string, mode: "100644" | "120000", path: string, content: string): void {
  const objectId = git(["hash-object", "-w", "--stdin"], { stdin: content });
  git(["update-index", "--add", "--cacheinfo", mode, objectId, path], { index });
}

async function runHook(index: string, env: NodeJS.ProcessEnv = process.env): Promise<{
  exitCode: number;
  output: string;
}> {
  const child = Bun.spawn([join(repoRoot, ".githooks", "pre-commit")], {
    cwd: repoRoot,
    env: { ...env, GIT_INDEX_FILE: index },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

describe("pre-commit hook", () => {
  test("skips staged source symlinks while rejecting regular lint errors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "timeline-pre-commit-test-"));
    try {
      const index = createIndex(directory);
      addBlob(index, "120000", "web/src/__precommit_symlink.ts", "../vite.config.ts");

      const symlinkOnly = await runHook(index);

      expect(symlinkOnly.exitCode).toBe(0);
      expect(symlinkOnly.output).toContain(
        "Skipping lint for staged symlink: web/src/__precommit_symlink.ts",
      );
      expect(symlinkOnly.output).not.toContain("Invalid regex flag");

      addBlob(
        index,
        "100644",
        "web/src/__precommit_failure.ts",
        "declare const value: string | undefined;\nexport const required = value!;\n",
      );

      const result = await runHook(index);

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Skipping lint for staged symlink: web/src/__precommit_symlink.ts");
      expect(result.output).toContain("noNonNullAssertion");
      expect(result.output).not.toContain("Invalid regex flag");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("runs full lint checks for staged configuration changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "timeline-pre-commit-test-"));
    try {
      const index = createIndex(directory);
      const config = git(["show", "HEAD:biome.json"]);
      const strictConfig = config.replace(
        '"noExplicitAny": "warn"',
        '"noExplicitAny": "error"',
      );
      if (strictConfig === config) throw new Error("biome.json has no noExplicitAny warning rule");
      addBlob(index, "100644", "biome.json", `${strictConfig}\n`);

      const result = await runHook(index);

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("noExplicitAny");
      expect(result.output).not.toContain("unbound variable");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects an index mutation after freezing the checked tree", async () => {
    const directory = mkdtempSync(join(tmpdir(), "timeline-pre-commit-test-"));
    try {
      const index = createIndex(directory);
      const objectId = git(["hash-object", "-w", "--stdin"], {
        stdin: "alice@example.com\n",
      });
      const binDirectory = join(directory, "bin");
      mkdirSync(binDirectory);
      const fakeBun = join(binDirectory, "bun");
      writeFileSync(fakeBun, [
        "#!/usr/bin/env bash",
        'GIT_INDEX_FILE="$TEST_LIVE_INDEX" git update-index --add --cacheinfo 100644 "$TEST_BLOB" notes.txt',
        'exec "$TEST_REAL_BUN" "$@"',
      ].join("\n"));
      chmodSync(fakeBun, 0o755);
      const path = process.env.PATH;
      if (!path) throw new Error("PATH is required for the pre-commit test");

      const result = await runHook(index, {
        ...process.env,
        PATH: `${binDirectory}:${path}`,
        TEST_BLOB: objectId,
        TEST_LIVE_INDEX: index,
        TEST_REAL_BUN: process.execPath,
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(
        "The Git index changed while pre-commit checks were running; retry the commit.",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
