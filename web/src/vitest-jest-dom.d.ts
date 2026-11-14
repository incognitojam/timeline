// Vitest 5 reads custom matcher types from `Matchers<R, T>`, which
// @testing-library/jest-dom 7 does not augment. Remove this file, and point
// tsconfig `types` at "@testing-library/jest-dom/vitest", once a jest-dom
// release ships testing-library/jest-dom#742.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Matchers<R, T> extends TestingLibraryMatchers<unknown, R> {}
}
