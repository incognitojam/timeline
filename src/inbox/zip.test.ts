import { describe, expect, test } from "bun:test";
import { detectZipContent } from "./zip";

describe("detectZipContent", () => {
  test("recognizes a ChatGPT export containing only numbered conversation files", () => {
    expect(
      detectZipContent([
        "/export/conversations (1).json",
        "/export/conversations (2).json",
        "/export/user.json",
      ])
    ).toBe("chatgpt");
  });
});
