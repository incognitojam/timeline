/**
 * Minimal ambient declaration for the `Bun.Image` API (added in Bun 1.3.14).
 *
 * `bun-types` (1.3.x, via `@types/bun`) does not yet declare `Bun.Image`. Only
 * the subset this project uses is declared here — extend it as more of the API
 * gets used, and delete this file once `bun-types` declares `Image` itself.
 *
 * Augments the "bun" module (not a global `namespace Bun`, which would shadow
 * the module's other members like `Bun.file`).
 */

declare module "bun" {
  class Image {
    constructor(input: Blob | ArrayBufferView | ArrayBufferLike | string);
    /** Runs on the calling thread (unlike the transform/encode methods). */
    metadata(): Promise<{ width: number; height: number; format: string }>;
  }
}
