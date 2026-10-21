import { getEncoding } from "js-tiktoken";

// cl100k_base is used by GPT-4, GPT-3.5-turbo, and Claude
const encoder = getEncoding("cl100k_base");

export function countTokens(text: string): number {
  return encoder.encode(text).length;
}
