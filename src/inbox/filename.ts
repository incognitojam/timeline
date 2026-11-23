import { basename } from "path";

export function isHiddenInboxFile(path: string): boolean {
  return basename(path).startsWith(".");
}
