#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PRODUCT_VERSION } from "../src/product-version";

const repoRoot = resolve(import.meta.dir, "..");
const infoPlistPath = join(repoRoot, "tools", "timeline-app", "Info.plist");
const current = readFileSync(infoPlistPath, "utf8");
const versionPattern = /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<]*)(<\/string>)/;

if (!versionPattern.test(current)) {
  throw new Error(`Could not find CFBundleShortVersionString in ${infoPlistPath}`);
}

const updated = current.replace(
  versionPattern,
  (_match, before: string, _version: string, after: string) =>
    `${before}${PRODUCT_VERSION}${after}`,
);
if (updated !== current) writeFileSync(infoPlistPath, updated);

console.log(`Synchronized Timeline product version ${PRODUCT_VERSION}`);
