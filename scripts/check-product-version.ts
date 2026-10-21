#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PRODUCT_VERSION } from "../src/product-version";

const repoRoot = resolve(import.meta.dir, "..");
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  private?: unknown;
};
if (rootPackage.private !== true) throw new Error("package.json must remain private");

const infoPlist = readFileSync(join(repoRoot, "tools", "timeline-app", "Info.plist"), "utf8");
const plistVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(infoPlist)?.[1];
if (!plistVersion) throw new Error("Timeline Info.plist has no CFBundleShortVersionString");
if (plistVersion !== PRODUCT_VERSION) {
  throw new Error(
    `Product version mismatch: package.json is ${PRODUCT_VERSION}, Timeline Info.plist is ${plistVersion}. Run bun run version:sync.`,
  );
}
const plistBuild = /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(infoPlist)?.[1];
if (!plistBuild || !/^\d+$/.test(plistBuild)) {
  throw new Error("Timeline Info.plist must have a numeric CFBundleVersion");
}

const webPackage = JSON.parse(readFileSync(join(repoRoot, "web", "package.json"), "utf8")) as {
  private?: unknown;
  version?: unknown;
};
if (webPackage.private !== true) throw new Error("web/package.json must remain private");
if (webPackage.version !== undefined) {
  throw new Error("web/package.json must not declare a second product version");
}

console.log(`Product version ${PRODUCT_VERSION} is consistent`);
