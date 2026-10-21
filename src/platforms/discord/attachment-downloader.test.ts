import { describe, test, expect } from "bun:test";
import { safeFileName } from "./attachment-downloader";

describe("safeFileName", () => {
  test("strips directory components from a traversal-style filename", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("/etc/passwd")).toBe("passwd");
    expect(safeFileName("foo/bar/baz.jpg")).toBe("baz.jpg");
  });

  test("collapses parent-dir-only inputs to a safe placeholder", () => {
    expect(safeFileName("..")).toBe("unnamed");
    expect(safeFileName("...")).toBe("unnamed");
    expect(safeFileName("/")).toBe("unnamed");
  });

  test("strips leading dots so hidden-file names can't be planted", () => {
    expect(safeFileName(".bashrc")).toBe("bashrc");
    expect(safeFileName("..hidden")).toBe("hidden");
  });

  test("preserves a normal filename unchanged", () => {
    expect(safeFileName("photo.jpg")).toBe("photo.jpg");
    expect(safeFileName("My Document v2.pdf")).toBe("My Document v2.pdf");
  });

  test("truncates over-long names while preserving the extension", () => {
    const long = "a".repeat(300) + ".png";
    const result = safeFileName(long);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(255);
    expect(result.endsWith(".png")).toBe(true);
  });
});
