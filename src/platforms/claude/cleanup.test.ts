import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractedExports } from "./export";

test("the next import cleans an extraction abandoned by a killed importer", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-cleanup-test-"));
  try {
    await writeFile(join(root, "conversations.json"), "[]");
    const zip = join(root, "conversations-000.zip");
    const zipper = Bun.spawn(["zip", "-q", zip, "conversations.json"], { cwd: root });
    expect(await zipper.exited).toBe(0);
    const marker = join(root, "extracted-path");
    const script = `
      import { extractedExports } from ${JSON.stringify(join(import.meta.dir, "export.ts"))};
      const iterator = extractedExports(${JSON.stringify(zip)});
      const result = await iterator.next();
      if (result.done) throw new Error("No extraction");
      await Bun.write(${JSON.stringify(marker)}, result.value.tempDir);
      process.kill(process.pid, "SIGKILL");
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).not.toBe(0);
    const abandoned = await Bun.file(marker).text();
    expect(existsSync(abandoned)).toBe(true);
    let current = "";
    for await (const extracted of extractedExports(zip)) { current = extracted.tempDir; break; }
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(current)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
