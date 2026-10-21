/**
 * Image dimension extraction via Bun.Image (Bun >= 1.3.14).
 *
 * Replaces probe-image-size: Bun.Image's metadata() decodes only the header
 * and runs on the calling thread, with no native module to install.
 */

/**
 * Read the pixel dimensions of an encoded image.
 *
 * @param input Raw image bytes, or a path to an image file.
 * @returns The image's width and height in pixels.
 * @throws If the input cannot be read or decoded as a supported image format.
 *   Callers decide how to handle failures (e.g. store null dimensions, or
 *   distinguish a missing file from a corrupt image).
 */
export async function imageDimensions(
  input: Uint8Array | string
): Promise<{ width: number; height: number }> {
  const image =
    typeof input === "string" ? new Bun.Image(Bun.file(input)) : new Bun.Image(input);
  const { width, height } = await image.metadata();
  return { width, height };
}
