import { createReadStream } from "node:fs";

/** Read one object at a time without retaining the complete export. */
export async function* readJsonArray(path: string): AsyncGenerator<unknown> {
  let state: "start" | "value" | "object" | "separator" | "end" = "start";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let buffer = "";
  let afterComma = false;
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    for (const char of chunk) {
      if (state === "object") {
        buffer += char;
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "{" || char === "[") depth++;
        else if (char === "}" || char === "]") depth--;
        if (depth === 0) {
          yield JSON.parse(buffer) as unknown;
          buffer = "";
          state = "separator";
        }
        continue;
      }
      if (/\s/.test(char)) continue;
      if (state === "start" && char === "[") state = "value";
      else if (state === "value" && char === "{") {
        buffer = char;
        depth = 1;
        state = "object";
        afterComma = false;
      } else if (state === "separator" && char === ",") {
        state = "value";
        afterComma = true;
      } else if ((state === "separator" || (state === "value" && !afterComma)) && char === "]") state = "end";
      else throw new Error("Expected a JSON array of objects in Claude export");
    }
  }
  if (state !== "end") throw new Error("Incomplete Claude JSON array");
}
