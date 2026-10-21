import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";

export interface PublicTreeFinding {
  path: string;
  line: number | null;
  rule: string;
}

interface ContentRule {
  rule: string;
  pattern: RegExp;
}

const textDecoder = new TextDecoder();

const pattern = (...parts: string[]): RegExp => new RegExp(parts.join(""), "gim");
const caseSensitivePattern = (...parts: string[]): RegExp => new RegExp(parts.join(""), "gm");

// Keep signatures split across source literals so this checker does not report
// its own definitions. Findings deliberately omit matched values from output.
const credentialRules: ContentRule[] = [
  {
    rule: "private-key",
    pattern: pattern("BEGIN ", "(?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY"),
  },
  { rule: "aws-access-key", pattern: pattern("(?:AK", "IA|AS", "IA)[0-9A-Z]{16}") },
  {
    rule: "github-token",
    pattern: pattern("(?:github_pat_", "[A-Za-z0-9_]+|gh[pousr]_", "[A-Za-z0-9]{30,})"),
  },
  { rule: "openai-api-key", pattern: pattern("sk-", "(?:proj-)?", "[A-Za-z0-9_-]{20,}") },
  { rule: "slack-token", pattern: pattern("xox", "[baprs]-", "[A-Za-z0-9-]{10,}") },
  { rule: "google-api-key", pattern: pattern("AI", "za", "[0-9A-Za-z_-]{30,}") },
  { rule: "stripe-live-key", pattern: pattern("[sr]k_", "live_", "[0-9A-Za-z]{16,}") },
  {
    rule: "jwt",
    pattern: pattern("eyJ", "[A-Za-z0-9_-]+\\.", "[A-Za-z0-9_-]+\\.", "[A-Za-z0-9_-]+"),
  },
];

const credentialLiteralPattern = pattern(
  "\\b(api[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|mcp[_-]?tokens?|password)\\b",
  "\\s*[:=]\\s*[\"']([^\"'\\r\\n]{8,})[\"']"
);

const placeholderCredential = /^(?:example|fake|mock|placeholder|smoke|test|your[-_]|choose[-_]|password(?:123)?$|secret$|token$|new-access$|old-access$|expired-token$|existing-refresh$|rotated-refresh$)/i;

const emailPattern = pattern("[A-Za-z0-9._%+-]+@", "[A-Za-z0-9.-]+\\.[A-Za-z]{2,}");
const tailnetHostnamePattern = pattern("\\b[A-Za-z0-9.-]+\\.", "ts\\.net\\b");
const macHomePattern = caseSensitivePattern("/", "Users/", "([^/\\s\"'`]+)");
const linuxHomePattern = caseSensitivePattern("/", "home/", "([^/\\s\"'`]+)");
const windowsHomePattern = pattern("[A-Za-z]:\\\\", "Users\\\\", "([^\\\\\\s\"'`]+)");
const internationalPhonePattern = pattern("(?<![A-Za-z0-9])\\+", "[1-9][0-9 ()-]{7,}[0-9](?![A-Za-z0-9])");
const ukPostcodePattern = pattern(
  "\\b(?:GIR ",
  "0AA|(?:(?:[A-Z][0-9]{1,2}|[A-Z][A-HJ-Y][0-9]{1,2}|",
  "[A-Z][0-9][A-Z]|[A-Z][A-HJ-Y][0-9][A-Z]) [0-9][A-Z]{2}))\\b"
);
const allowedHomeUsers = new Set(["alice", "bob", "x", "timeline", "your-user", "YOUR_USERNAME"]);

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (text.charCodeAt(index) === 10) line++;
  }
  return line;
}

function findingsForMatches(path: string, text: string, rule: ContentRule): PublicTreeFinding[] {
  rule.pattern.lastIndex = 0;
  return Array.from(text.matchAll(rule.pattern), (match) => ({
    path,
    line: lineAt(text, match.index),
    rule: rule.rule,
  }));
}

function allowedEmail(value: string): boolean {
  const domain = value.slice(value.lastIndexOf("@") + 1).toLowerCase();
  return domain === "example.com" ||
    domain === "example.net" ||
    domain === "example.org" ||
    domain.endsWith(".example.com") ||
    domain === "thread.skype" ||
    domain === "chat.facebook.com" ||
    value.toLowerCase().includes("noreply");
}

function normalizedPhone(value: string): string {
  return value.replace(/[^+0-9]/g, "");
}

function allowedExamplePhone(value: string): boolean {
  const normalized = normalizedPhone(value);
  return pattern("^\\+44", "7700900", "[0-9]{3}$").test(normalized) ||
    pattern("^\\+1", "20255501", "[0-9]{2}$").test(normalized) ||
    pattern("^\\+1", "555", "[0-9]+$").test(normalized);
}

function addRejectedMatches(
  findings: PublicTreeFinding[],
  path: string,
  text: string,
  rule: string,
  regex: RegExp,
  allowed: (match: RegExpMatchArray) => boolean
): void {
  regex.lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    if (!allowed(match)) {
      findings.push({ path, line: lineAt(text, match.index), rule });
    }
  }
}

export function scanPublicTreeText(path: string, text: string): PublicTreeFinding[] {
  const findings = credentialRules.flatMap((rule) => findingsForMatches(path, text, rule));

  credentialLiteralPattern.lastIndex = 0;
  for (const match of text.matchAll(credentialLiteralPattern)) {
    const value = match[2];
    if (value.length >= 16 && !placeholderCredential.test(value)) {
      findings.push({ path, line: lineAt(text, match.index), rule: "credential-literal" });
    }
  }

  if (path.startsWith("repos/")) return findings;

  addRejectedMatches(findings, path, text, "non-example-email", emailPattern, (match) => allowedEmail(match[0]));
  addRejectedMatches(findings, path, text, "private-tailnet-hostname", tailnetHostnamePattern, (match) =>
    match[0].toLowerCase() === "example.ts.net" || match[0].toLowerCase().endsWith(".example.ts.net")
  );
  addRejectedMatches(findings, path, text, "personal-macos-path", macHomePattern, (match) =>
    allowedHomeUsers.has(match[1])
  );
  addRejectedMatches(findings, path, text, "personal-linux-path", linuxHomePattern, (match) =>
    allowedHomeUsers.has(match[1])
  );
  addRejectedMatches(findings, path, text, "personal-windows-path", windowsHomePattern, (match) =>
    allowedHomeUsers.has(match[1])
  );
  addRejectedMatches(findings, path, text, "non-example-phone", internationalPhonePattern, (match) =>
    allowedExamplePhone(match[0])
  );

  findings.push(...findingsForMatches(path, text, { rule: "uk-postcode", pattern: ukPostcodePattern }));
  return findings;
}

export function checkPublicTreePath(path: string): PublicTreeFinding[] {
  const lower = path.toLowerCase();
  const unsafeArtifact = /(^|\/)\.env(?:\.|$)|\.(?:db|db-wal|db-shm|sqlite|sqlite3|pem|key|p12|pfx|har|csv|jsonl|ndjson|zip|tgz|7z)$/i;
  const unsafeDirectory = /(^|\/)(?:imports?|relationship-output|playwright-report|test-results)(?:\/|$)/i;

  if ((unsafeArtifact.test(lower) && !lower.endsWith(".env.example")) || unsafeDirectory.test(lower)) {
    return [{ path, line: null, rule: "unsafe-tracked-artifact" }];
  }
  return [];
}

function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${textDecoder.decode(result.stderr).trim()}`);
  }
  return textDecoder.decode(result.stdout).split("\0").filter(Boolean);
}

function changedStagedPaths(cwd: string): Set<string> {
  const result = Bun.spawnSync([
    "git",
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMRT",
    "--no-renames",
    "-z",
  ], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git diff --cached failed: ${textDecoder.decode(result.stderr).trim()}`);
  }

  return new Set(textDecoder.decode(result.stdout).split("\0").filter(Boolean));
}

interface IndexEntry {
  path: string;
  objectId: string;
}

function stagedFiles(cwd: string): IndexEntry[] {
  const changedPaths = changedStagedPaths(cwd);
  if (changedPaths.size === 0) return [];

  const result = Bun.spawnSync(["git", "ls-files", "--stage", "-z"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files --stage failed: ${textDecoder.decode(result.stderr).trim()}`);
  }

  return textDecoder.decode(result.stdout).split("\0").filter(Boolean).map((entry) => {
    const match = entry.match(/^[0-7]{6} ([0-9a-f]+) 0\t(.+)$/s);
    if (!match) throw new Error(`Unexpected git index entry: ${entry}`);
    return { objectId: match[1], path: match[2] };
  }).filter((entry) => changedPaths.has(entry.path));
}

function stagedBlobs(entries: IndexEntry[], cwd: string): Map<string, Uint8Array> {
  const objectIds = [...new Set(entries.map((entry) => entry.objectId))];
  if (objectIds.length === 0) return new Map();

  const result = Bun.spawnSync(["git", "cat-file", "--batch"], {
    cwd,
    stdin: Buffer.from(`${objectIds.join("\n")}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git cat-file --batch failed: ${textDecoder.decode(result.stderr).trim()}`);
  }

  const output = result.stdout;
  const blobs = new Map<string, Uint8Array>();
  let offset = 0;
  for (const expectedObjectId of objectIds) {
    const newline = output.indexOf(10, offset);
    if (newline === -1) throw new Error(`Missing git object header for ${expectedObjectId}`);
    const header = textDecoder.decode(output.subarray(offset, newline));
    const match = header.match(/^([0-9a-f]+) blob ([0-9]+)$/);
    if (!match || match[1] !== expectedObjectId) {
      throw new Error(`Unexpected git object header: ${header}`);
    }

    const size = Number.parseInt(match[2], 10);
    const contentStart = newline + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length || output[contentEnd] !== 10) {
      throw new Error(`Truncated git object ${expectedObjectId}`);
    }
    blobs.set(expectedObjectId, output.slice(contentStart, contentEnd));
    offset = contentEnd + 1;
  }
  return blobs;
}

function readTrackedFile(path: string): Uint8Array | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(path));
  if (!stat.isFile()) return null;
  return readFileSync(path);
}

export function checkPublicTree(paths: string[]): PublicTreeFinding[] {
  const findings: PublicTreeFinding[] = [];
  for (const path of paths) {
    findings.push(...checkPublicTreePath(path));
    const bytes = readTrackedFile(path);
    if (!bytes || bytes.includes(0)) continue;
    findings.push(...scanPublicTreeText(path, textDecoder.decode(bytes)));
  }
  return findings;
}

function checkStagedPublicTreeEntries(entries: IndexEntry[], cwd: string): PublicTreeFinding[] {
  const findings: PublicTreeFinding[] = [];
  const blobs = stagedBlobs(entries, cwd);
  for (const entry of entries) {
    findings.push(...checkPublicTreePath(entry.path));
    const bytes = blobs.get(entry.objectId);
    if (!bytes) throw new Error(`Missing staged blob ${entry.objectId} for ${entry.path}`);
    if (bytes.includes(0)) continue;
    findings.push(...scanPublicTreeText(entry.path, textDecoder.decode(bytes)));
  }
  return findings;
}

export function checkStagedPublicTree(cwd: string = process.cwd()): PublicTreeFinding[] {
  return checkStagedPublicTreeEntries(stagedFiles(cwd), cwd);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--staged") || args.length > 1) {
    console.error("Usage: bun run src/scripts/check-public-release-safety.ts [--staged]");
    process.exitCode = 2;
    return;
  }

  const findings = args[0] === "--staged"
    ? checkStagedPublicTree()
    : checkPublicTree(trackedFiles());
  if (findings.length === 0) {
    console.log("Public release safety check passed.");
    return;
  }

  console.error("Public release safety check failed. Matched values are redacted:");
  for (const finding of findings) {
    const location = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
    console.error(`- ${location} [${finding.rule}]`);
  }
  console.error("Replace private data with synthetic examples or investigate the credential finding.");
  process.exitCode = 1;
}

if (import.meta.main) await main();
