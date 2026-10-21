#!/usr/bin/env bun

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import { PRODUCT_VERSION } from "../src/product-version";

const repoRoot = resolve(import.meta.dir, "..");
const ARTIFACT_MARKER = ".timeline-service-artifact";

function parseOutputPath(args: string[]): string {
  if (args.length === 0) return join(repoRoot, "dist", "timeline-service");
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
    throw new Error("usage: bun run build:service [--output <directory>]");
  }
  return resolve(args[1]);
}

function assertSafeOutputPath(outputPath: string): void {
  if (
    outputPath === parse(outputPath).root ||
    outputPath === repoRoot ||
    outputPath === dirname(repoRoot)
  ) {
    throw new Error(`refusing unsafe artifact output path: ${outputPath}`);
  }
  if (basename(outputPath) !== "timeline-service") {
    throw new Error(`artifact output directory must be named timeline-service: ${outputPath}`);
  }
  if (existsSync(outputPath) && !existsSync(join(outputPath, ARTIFACT_MARKER))) {
    throw new Error(`refusing to replace a directory without ${ARTIFACT_MARKER}: ${outputPath}`);
  }
}

async function run(command: string[], cwd = repoRoot): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  }
}

function gitOutput(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function git(...args: string[]): string {
  const value = gitOutput(args);
  if (!value) throw new Error(`git ${args.join(" ")} returned no value`);
  return value;
}

function appBuildNumber(): string {
  const infoPlist = join(repoRoot, "tools", "timeline-app", "Info.plist");
  const result = Bun.spawnSync(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleVersion", infoPlist], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`could not read CFBundleVersion from Timeline Info.plist: ${result.stderr.toString().trim()}`);
  }
  const value = result.stdout.toString().trim();
  if (!value) throw new Error("Timeline Info.plist has an empty CFBundleVersion");
  return value;
}

function copyRuntimePackage(packageName: string, modulesRoot: string): void {
  const source = join(repoRoot, "node_modules", ...packageName.split("/"));
  if (!existsSync(source)) {
    throw new Error(`required runtime package is missing: ${packageName}`);
  }
  const destination = join(modulesRoot, ...packageName.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

async function buildArtifact(outputPath: string): Promise<void> {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error(`service artifacts currently support macOS arm64/x64, not ${process.platform}-${process.arch}`);
  }

  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
    packageManager?: unknown;
  };
  const expectedBunVersion =
    typeof packageJson.packageManager === "string"
      ? /^bun@(.+)$/.exec(packageJson.packageManager)?.[1]
      : undefined;
  if (!expectedBunVersion) {
    throw new Error("package.json has no pinned Bun packageManager version");
  }
  if (Bun.version !== expectedBunVersion) {
    throw new Error(`artifact requires Bun ${expectedBunVersion}, running ${Bun.version}`);
  }
  const version = PRODUCT_VERSION;
  const buildNumber = process.env.TIMELINE_BUILD_NUMBER ?? appBuildNumber();
  if (!/^\d+$/.test(buildNumber)) {
    throw new Error(`Timeline build number must contain only digits: ${buildNumber}`);
  }

  await run([process.execPath, "run", "build"], join(repoRoot, "web"));

  const outputParent = dirname(outputPath);
  mkdirSync(outputParent, { recursive: true });
  const stage = mkdtempSync(join(outputParent, `.${basename(outputPath)}-build.`));
  try {
    const binDir = join(stage, "bin");
    const resourcesDir = join(stage, "Resources");
    const runtimeDir = join(resourcesDir, "runtime");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(stage, ARTIFACT_MARKER), "Timeline relocatable service artifact\n");

    const build = await Bun.build({
      entrypoints: [
        join(repoRoot, "src", "service.ts"),
        join(repoRoot, "src", "scheduler", "worker.ts"),
        join(repoRoot, "src", "db", "pool-worker.ts"),
        join(repoRoot, "src", "parsers", "monzo.ts"),
      ],
      root: join(repoRoot, "src"),
      outdir: runtimeDir,
      target: "bun",
      external: ["sharp", "sqlite-vec"],
      minify: false,
      sourcemap: "none",
      // Bun.build otherwise inlines the build machine's NODE_ENV, defaulting
      // to "development", which would disable the service's auth requirement.
      define: { "process.env.NODE_ENV": "process.env.NODE_ENV" },
    });
    if (!build.success) {
      for (const log of build.logs) console.error(log);
      throw new Error("service bundle failed");
    }

    const modulesRoot = join(runtimeDir, "node_modules");
    const platform = `${process.platform}-${process.arch}`;
    for (const packageName of [
      "sharp",
      "detect-libc",
      "semver",
      "@img/colour",
      `@img/sharp-${platform}`,
      `@img/sharp-libvips-${platform}`,
      "sqlite-vec",
      `sqlite-vec-${platform}`,
    ]) {
      copyRuntimePackage(packageName, modulesRoot);
    }

    const bunExecutable = realpathSync(process.execPath);
    cpSync(bunExecutable, join(binDir, "bun"));
    chmodSync(join(binDir, "bun"), 0o755);
    cpSync(
      join(repoRoot, "scripts", "artifact", "timeline-environment"),
      join(binDir, "timeline-environment"),
    );
    cpSync(join(repoRoot, "scripts", "artifact", "timeline-service"), join(binDir, "timeline-service"));
    chmodSync(join(binDir, "timeline-service"), 0o755);

    cpSync(join(repoRoot, "web", "dist"), join(resourcesDir, "web"), { recursive: true });

    const builtAt = process.env.TIMELINE_BUILT_AT ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(builtAt))) {
      throw new Error(`build time must be an ISO-compatible timestamp: ${builtAt}`);
    }
    const versionInfo = {
      version,
      build: buildNumber,
      commit: git("rev-parse", "--short=7", "HEAD"),
      commitFull: git("rev-parse", "HEAD"),
      message: git("log", "-1", "--format=%s"),
      branch: process.env.GITHUB_REF_NAME ?? git("rev-parse", "--abbrev-ref", "HEAD"),
      builtAt,
      dirty: gitOutput(["status", "--porcelain"]) !== "",
    };
    writeFileSync(join(resourcesDir, "version.json"), `${JSON.stringify(versionInfo, null, 2)}\n`);

    rmSync(outputPath, { recursive: true, force: true });
    renameSync(stage, outputPath);
    console.log(`Built relocatable service artifact: ${outputPath}`);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

const outputPath = parseOutputPath(process.argv.slice(2));
assertSafeOutputPath(outputPath);
await buildArtifact(outputPath);
