import { describe, expect, test } from "bun:test";
import { parseInterval } from "../../config";
import { isRegisteredSource } from "../../shared/sources";
import { SYNC_SOURCES } from ".";

describe("sync source registry", () => {
  test("every sync source has shared display metadata", () => {
    const missing = SYNC_SOURCES.map((source) => source.name).filter(
      (source) => !isRegisteredSource(source),
    );

    expect(missing).toEqual([]);
  });

  test("every source default interval is a positive interval", () => {
    for (const { defaultInterval } of SYNC_SOURCES) {
      if (defaultInterval) expect(parseInterval(defaultInterval)).toBeGreaterThan(0);
    }
  });
});
