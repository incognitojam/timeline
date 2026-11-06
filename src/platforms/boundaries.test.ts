import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { Glob } from "bun";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SERVER_SRC = join(REPO_ROOT, "src");
const WEB_SRC = join(REPO_ROOT, "web/src");

const ALIASES: Readonly<Record<string, string>> = {
  "@platforms/": join(SERVER_SRC, "platforms"),
  "@shared/": join(SERVER_SRC, "shared"),
};

const RUNTIME_BUILTINS = new Set(builtinModules);

/** Dependency-free modules outside the web-safe trees that src/shared needs; still checked transitively. */
const WEB_SAFE_LIB_MODULES = new Set(["src/lib/phone.ts"]);

/** npm packages web-safe code may use. Anything else may pull in Node built-ins or native code. */
const WEB_SAFE_PACKAGES = new Set(["date-fns"]);

/** Every module specifier in a file, including type-only imports and re-exports. */
export function moduleSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specifiers = new Set<string>();
  const patterns = [
    /\b(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specifiers.add(match[1] as string);
  }
  return [...specifiers];
}

function resolveModule(fromFile: string, specifier: string): string | null {
  let base: string | null = null;
  if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    for (const [alias, target] of Object.entries(ALIASES)) {
      if (specifier.startsWith(alias)) base = join(target, specifier.slice(alias.length));
    }
  }
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${relative(REPO_ROOT, fromFile)}: cannot resolve ${specifier}`);
}

function isServerRuntimeModule(specifier: string): boolean {
  return specifier.startsWith("bun:") || specifier === "bun" || specifier.startsWith("node:") || RUNTIME_BUILTINS.has(specifier);
}

/** Server-tree files that the web app may load: platform metadata and web-safe helpers. */
export function isWebSafePlatformPath(repoPath: string): boolean {
  if (!repoPath.startsWith("src/platforms/")) return false;
  const inPlatform = repoPath.slice("src/platforms/".length);
  return inPlatform === "types.ts" || inPlatform === "metas.ts" || inPlatform.endsWith("/meta.ts") || inPlatform.split("/").slice(1, -1).includes("shared");
}

function isWebSafePath(repoPath: string): boolean {
  return repoPath.startsWith("src/shared/") || WEB_SAFE_LIB_MODULES.has(repoPath) || isWebSafePlatformPath(repoPath);
}

/** Violations reachable from one web-safe file, following imports transitively. */
async function webSafetyViolations(entry: string, seen: Set<string>): Promise<string[]> {
  if (seen.has(entry)) return [];
  seen.add(entry);
  const violations: string[] = [];
  const from = relative(REPO_ROOT, entry);
  for (const specifier of moduleSpecifiers(await Bun.file(entry).text())) {
    if (isServerRuntimeModule(specifier)) {
      violations.push(`${from} imports server-only ${specifier}`);
      continue;
    }
    const target = resolveModule(entry, specifier);
    if (target === null) {
      if (!WEB_SAFE_PACKAGES.has(specifier)) violations.push(`${from} imports package ${specifier}`);
      continue;
    }
    const to = relative(REPO_ROOT, target);
    if (!isWebSafePath(to)) {
      violations.push(`${from} imports ${to}, which is not web-safe`);
      continue;
    }
    violations.push(...(await webSafetyViolations(target, seen)));
  }
  return violations;
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const path of new Glob("**/*.{ts,tsx}").scan({ cwd: root, absolute: true })) {
    if (!/\.test\.tsx?$/.test(path)) files.push(path);
  }
  return files;
}

describe("moduleSpecifiers", () => {
  test("finds value, type-only, re-export, side-effect and dynamic imports", () => {
    const source = `
      import a from "./a";
      import type { B } from "./b";
      import {
        c,
      } from "./c";
      export { d } from "./d";
      export type { E } from "./e";
      import "./f";
      const g = await import("./g");
      // import commented from "./h";
    `;
    expect(moduleSpecifiers(source).sort()).toEqual(["./a", "./b", "./c", "./d", "./e", "./f", "./g"]);
  });

  test("finds require forms and dynamic imports with options", () => {
    const source = `
      import type Sqlite = require("bun:sqlite");
      const fs = require("node:fs");
      const data = await import("./data", { with: { type: "json" } });
    `;
    expect(moduleSpecifiers(source).sort()).toEqual(["./data", "bun:sqlite", "node:fs"]);
  });
});

describe("isWebSafePlatformPath", () => {
  test.each([
    ["src/platforms/types.ts", true],
    ["src/platforms/metas.ts", true],
    ["src/platforms/discord/meta.ts", true],
    ["src/platforms/google/calendar/meta.ts", true],
    ["src/platforms/discord/shared/forward.ts", true],
    ["src/platforms/index.ts", false],
    ["src/platforms/discord/index.ts", false],
    ["src/platforms/discord/client.ts", false],
    ["src/platforms/discord/shared.ts", false],
    ["src/shared/sources.ts", false],
  ])("%s -> %p", (path, expected) => {
    expect(isWebSafePlatformPath(path)).toBe(expected);
  });
});

describe("web bundle boundary", () => {
  test("web code reaches src/platforms only through metadata and shared helpers", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(WEB_SRC)) {
      const from = relative(REPO_ROOT, file);
      for (const specifier of moduleSpecifiers(await Bun.file(file).text())) {
        const target = specifier.startsWith("@platforms/") || specifier.startsWith(".") ? resolveModule(file, specifier) : null;
        if (target === null) continue;
        const to = relative(REPO_ROOT, target);
        if (to.startsWith("web/")) continue;
        if (!isWebSafePath(to)) violations.push(`${from} imports ${to}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("everything the web app can reach in the server tree stays free of server code", async () => {
    const entries = new Set<string>();
    for (const file of await sourceFiles(WEB_SRC)) {
      for (const specifier of moduleSpecifiers(await Bun.file(file).text())) {
        const reachesServerTree = specifier.startsWith("@platforms/") || specifier.startsWith("@shared/") || specifier.startsWith(".");
        const target = reachesServerTree ? resolveModule(file, specifier) : null;
        if (target !== null && !relative(REPO_ROOT, target).startsWith("web/")) entries.add(target);
      }
    }
    for (const path of await sourceFiles(join(SERVER_SRC, "platforms"))) {
      if (isWebSafePlatformPath(relative(REPO_ROOT, path))) entries.add(path);
    }
    const seen = new Set<string>();
    const violations: string[] = [];
    for (const entry of entries) violations.push(...(await webSafetyViolations(entry, seen)));
    expect(violations).toEqual([]);
  });
});

/** Importing any of these from inside a platform would create an import cycle through the registries. */
const REGISTRY_MODULES = new Set([
  "src/platforms/index.ts",
  "src/platforms/metas.ts",
  "src/render/index.ts",
  "src/seed/sources/index.ts",
  "src/sync/sources/index.ts",
]);

/** Code the platforms build on. It may reach platforms only through their web-safe files. */
const CORE_ROOTS = ["src/db", "src/export", "src/lib", "src/media", "src/shared"];
const CORE_FILES = ["src/render/types.ts", "src/seed/context.ts", "src/sync/types.ts"];

/**
 * Server-tree platform files that core may import regardless: their only value
 * imports are web-safe, so they cannot pull anything that loops back into core.
 * The second test below holds them to that. `src/export` needs this one to quote
 * replies and it needs the database types, which keeps it out of `shared/`.
 */
const CORE_IMPORTABLE_PLATFORM_FILES = new Set(["src/platforms/discord/reply-references.ts"]);

/** The bundle's entry points in scripts/build-service-artifact.ts, plus the module the service runs. */
const SERVICE_ENTRY_POINTS = [
  "src/service.ts",
  "src/service-main.ts",
  "src/scheduler/worker.ts",
  "src/db/pool-worker.ts",
  "src/parsers/monzo.ts",
];

describe("platform layering", () => {
  test("platforms never import a registry", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(join(SERVER_SRC, "platforms"))) {
      const from = relative(REPO_ROOT, file);
      // The platform lists themselves sit one level above the platforms.
      if (REGISTRY_MODULES.has(from)) continue;
      for (const specifier of moduleSpecifiers(await Bun.file(file).text())) {
        const target = specifier.startsWith(".") ? resolveModule(file, specifier) : null;
        if (target !== null && REGISTRY_MODULES.has(relative(REPO_ROOT, target))) {
          violations.push(`${from} imports ${relative(REPO_ROOT, target)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("core code reaches platforms only through web-safe files", async () => {
    const files = CORE_FILES.map((file) => join(REPO_ROOT, file));
    for (const root of CORE_ROOTS) files.push(...(await sourceFiles(join(REPO_ROOT, root))));
    const violations: string[] = [];
    for (const file of files) {
      const from = relative(REPO_ROOT, file);
      for (const specifier of moduleSpecifiers(await Bun.file(file).text())) {
        const target = specifier.startsWith(".") ? resolveModule(file, specifier) : null;
        if (target === null) continue;
        const to = relative(REPO_ROOT, target);
        if (to.startsWith("src/platforms/") && !isWebSafePlatformPath(to) && !CORE_IMPORTABLE_PLATFORM_FILES.has(to)) {
          violations.push(`${from} imports ${to}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("platform files core may import have only web-safe value imports", async () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const violations: string[] = [];
    for (const path of CORE_IMPORTABLE_PLATFORM_FILES) {
      const file = join(REPO_ROOT, path);
      for (const { path: specifier } of transpiler.scanImports(await Bun.file(file).text())) {
        const target = resolveModule(file, specifier);
        if (target === null || !isWebSafePlatformPath(relative(REPO_ROOT, target))) {
          violations.push(`${path} imports ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("the service does not evaluate seed code", async () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const isSeedModule = (path: string) =>
      path.startsWith("src/seed/") || /^src\/platforms\/.+\/seed[^/]*(\.ts$|\/)/.test(path);
    const seen = new Set<string>();
    const pending = SERVICE_ENTRY_POINTS.map((path) => join(REPO_ROOT, path));
    const seedModules: string[] = [];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
      seen.add(file);
      if (isSeedModule(relative(REPO_ROOT, file))) seedModules.push(relative(REPO_ROOT, file));
      const code = (await Bun.file(file).text()).replace(/^#!.*/, "");
      for (const { path, kind } of transpiler.scanImports(code)) {
        const target = resolveModule(file, path);
        if (target === null) continue;
        // `loadSeeds` is the one sanctioned route, and it only runs for the seed runner.
        const isLazySeed = kind === "dynamic-import" && isSeedModule(relative(REPO_ROOT, target));
        if (!isLazySeed) pending.push(target);
      }
    }
    expect(seen.has(join(SERVER_SRC, "platforms/index.ts"))).toBe(true);
    expect(seedModules).toEqual([]);
  });
});
