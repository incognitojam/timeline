import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPublicTreePath,
  checkStagedPublicTree,
  scanPublicTreeText,
} from "./check-public-release-safety";

function rulesFor(text: string, path = "src/example.ts"): string[] {
  return scanPublicTreeText(path, text).map((finding) => finding.rule);
}

describe("public release safety check", () => {
  test("detects credential formats without returning their values", () => {
    const token = ["gh", "p_", "A".repeat(36)].join("");
    const findings = scanPublicTreeText("src/example.ts", `const value = "${token}";`);

    expect(findings).toEqual([{ path: "src/example.ts", line: 1, rule: "github-token" }]);
    expect(JSON.stringify(findings)).not.toContain(token);
  });

  test("detects high-entropy credential literals but permits placeholders", () => {
    const secret = "a8D4zQ1mN7vR2kP9x6";
    expect(rulesFor(`client_secret = "${secret}"`)).toContain("credential-literal");
    expect(rulesFor('client_secret = "your-client-secret"')).toEqual([]);
    expect(rulesFor('process.env.MCP_TOKENS = "test-token"')).toEqual([]);
  });

  test("detects private contact and infrastructure details", () => {
    const email = ["person", "@", "personal.invalid"].join("");
    const path = ["/", "Users/", "charlie/Developer/project"].join("");
    const hostname = ["timeline", ".private.", "ts.net"].join("");
    const postcode = ["SW", "1A", " 1AA"].join("");
    const rules = rulesFor([email, path, hostname, postcode].join("\n"));

    expect(rules).toEqual([
      "non-example-email",
      "private-tailnet-hostname",
      "personal-macos-path",
      "uk-postcode",
    ]);
  });

  test("permits the repository's synthetic conventions", () => {
    const text = [
      "alice@example.com",
      "/Users/alice/Developer/example-project",
      "/home/timeline/service",
      "timeline.example.ts.net",
      "+44 (7700) 900-123",
      "+1 202 555 0123",
    ].join("\n");

    expect(rulesFor(text)).toEqual([]);
  });

  test("applies only credential checks to vendored sources", () => {
    const privateLookingExample = ["person", "@", "upstream.invalid"].join("");
    expect(rulesFor(privateLookingExample, "repos/example/test.ts")).toEqual([]);
  });

  test("rejects tracked data and credential artifacts", () => {
    expect(checkPublicTreePath("timeline.db")[0]?.rule).toBe("unsafe-tracked-artifact");
    expect(checkPublicTreePath("exports/messages.jsonl")[0]?.rule).toBe("unsafe-tracked-artifact");
    expect(checkPublicTreePath("config/.env.example")).toEqual([]);
    expect(checkPublicTreePath("src/db/schema.ts")).toEqual([]);
  });

  test("scans staged content instead of an unstaged working copy", () => {
    const repo = mkdtempSync(join(tmpdir(), "timeline-public-safety-"));
    try {
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd: repo, stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      };
      git("init", "--quiet");

      const path = join(repo, "example.txt");
      const privateEmail = ["person", "@", "personal.invalid"].join("");
      writeFileSync(path, privateEmail);
      git("add", "example.txt");
      writeFileSync(path, "alice@example.com");

      expect(checkStagedPublicTree(repo)).toEqual([
        { path: "example.txt", line: 1, rule: "non-example-email" },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("scans only files changed in the staged commit", () => {
    const repo = mkdtempSync(join(tmpdir(), "timeline-public-safety-"));
    try {
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd: repo, stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      };
      git("init", "--quiet");

      const privateEmail = ["person", "@", "personal.invalid"].join("");
      writeFileSync(join(repo, "unchanged.txt"), privateEmail);
      writeFileSync(join(repo, "changed.txt"), "first version");
      git("add", ".");
      git("-c", "user.name=Alice", "-c", "user.email=alice@example.com", "commit", "--quiet", "-m", "initial");

      writeFileSync(join(repo, "changed.txt"), "second version");
      git("add", "changed.txt");

      expect(checkStagedPublicTree(repo)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("scans staged file type changes", () => {
    const repo = mkdtempSync(join(tmpdir(), "timeline-public-safety-"));
    try {
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd: repo, stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      };
      git("init", "--quiet");

      const path = join(repo, "example.txt");
      writeFileSync(path, "alice@example.com");
      git("add", "example.txt");
      git("-c", "user.name=Alice", "-c", "user.email=alice@example.com", "commit", "--quiet", "-m", "initial");

      rmSync(path);
      symlinkSync(["/", "Users/", "charlie/private"].join(""), path);
      git("add", "example.txt");

      expect(checkStagedPublicTree(repo)).toEqual([
        { path: "example.txt", line: 1, rule: "personal-macos-path" },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
