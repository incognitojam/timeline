import { describe, expect, test } from "bun:test";
import { isRegisteredSource } from "../../shared/sources";
import { SYNC_SOURCES } from ".";

describe("sync source registry", () => {
  test("every sync source has shared display metadata", () => {
    const missing = SYNC_SOURCES.map((source) => source.name).filter(
      (source) => !isRegisteredSource(source),
    );

    expect(missing).toEqual([]);
  });
});
