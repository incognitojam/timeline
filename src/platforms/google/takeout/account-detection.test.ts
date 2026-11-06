import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import { getRcloneConfigPath } from "./account-detection";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_RCLONE_CONFIG = process.env.RCLONE_CONFIG;

function restoreEnv(): void {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }

  if (ORIGINAL_RCLONE_CONFIG === undefined) {
    delete process.env.RCLONE_CONFIG;
  } else {
    process.env.RCLONE_CONFIG = ORIGINAL_RCLONE_CONFIG;
  }
}

describe("getRcloneConfigPath", () => {
  test("uses RCLONE_CONFIG when set", () => {
    try {
      process.env.RCLONE_CONFIG = "/tmp/timeline-rclone.conf";

      expect(getRcloneConfigPath()).toBe("/tmp/timeline-rclone.conf");
    } finally {
      restoreEnv();
    }
  });

  test("expands ~/ in RCLONE_CONFIG", () => {
    try {
      process.env.RCLONE_CONFIG = "~/Library/Application Support/rclone/rclone.conf";

      expect(getRcloneConfigPath()).toBe(
        join(homedir(), "Library", "Application Support", "rclone", "rclone.conf")
      );
    } finally {
      restoreEnv();
    }
  });

  test("falls back to the standard rclone config path", () => {
    try {
      delete process.env.RCLONE_CONFIG;
      process.env.HOME = "/Users/alice";

      expect(getRcloneConfigPath()).toBe("/Users/alice/.config/rclone/rclone.conf");
    } finally {
      restoreEnv();
    }
  });
});
