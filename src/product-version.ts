import packageJson from "../package.json";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (!SEMVER_PATTERN.test(packageJson.version)) {
  throw new Error(`package.json has an invalid product version: ${packageJson.version}`);
}

export const PRODUCT_VERSION = packageJson.version;
