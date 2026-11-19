import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonArray } from "./json-array";

test("streams nested objects, escaped quotes and unicode, rejects incomplete arrays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-array-"));
  const path = join(dir, "conversations.json");
  try {
    const records = [{ text: 'é [ ] { } \\"', nested: [{ value: 3 }] }, { text: "hello" }];
    await writeFile(path, JSON.stringify(records));
    const actual = [];
    for await (const record of readJsonArray(path)) actual.push(record);
    expect(actual).toEqual(records);
    for (const invalid of ['[{"a":1}', '[{},]', '{}', '[{},null]', '[] false']) {
      await writeFile(path, invalid);
      expect(async () => { for await (const _ of readJsonArray(path)) { /* consume */ } }).toThrow();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
