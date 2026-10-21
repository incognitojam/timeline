import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { imageDimensions } from "./dimensions";

// Tiny solid-colour images with known dimensions (base64-encoded).
const PNG_7x5 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFCAIAAAAG+GGPAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGM4IaeBiRhoJAoABQwk651Wm3kAAAAASUVORK5CYII=",
  "base64"
);
const JPG_13x9 = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAJAA0DASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJ+AZiz/2Q==",
  "base64"
);

describe("imageDimensions", () => {
  test("reads dimensions from PNG bytes", async () => {
    expect(await imageDimensions(PNG_7x5)).toEqual({ width: 7, height: 5 });
  });

  test("reads dimensions from JPEG bytes", async () => {
    expect(await imageDimensions(JPG_13x9)).toEqual({ width: 13, height: 9 });
  });

  test("reads dimensions from a file path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dimensions-test-"));
    const path = join(dir, "image.png");
    writeFileSync(path, PNG_7x5);
    expect(await imageDimensions(path)).toEqual({ width: 7, height: 5 });
  });

  test("rejects an undecodable format (SVG) with code ERR_IMAGE_UNKNOWN_FORMAT", async () => {
    // Bun.Image can't decode SVG, which probe-image-size handled. backfill-dimensions
    // branches on this exact code to skip such rows instead of counting them as errors.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    await expect(imageDimensions(svg)).rejects.toMatchObject({
      code: "ERR_IMAGE_UNKNOWN_FORMAT",
    });
  });

  test("throws ENOENT for a missing file", async () => {
    await expect(imageDimensions("/no/such/file.png")).rejects.toThrow(/ENOENT/);
  });
});
