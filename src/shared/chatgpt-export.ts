import { basename } from "path";

const CONVERSATIONS_FILE_PATTERN = /^conversations(?:[ _-]?\(?(\d+)\)?)?\.json$/i;

function conversationFileIndex(path: string): number {
  const match = CONVERSATIONS_FILE_PATTERN.exec(basename(path));
  if (!match) {
    throw new Error(`Not a ChatGPT conversations file: ${path}`);
  }
  return match[1] === undefined ? -1 : Number.parseInt(match[1], 10);
}

export function findChatGPTConversationFiles(paths: ReadonlyArray<string>): string[] {
  return paths
    .filter((path) => CONVERSATIONS_FILE_PATTERN.test(basename(path)))
    .sort((left, right) => {
      const indexDifference = conversationFileIndex(left) - conversationFileIndex(right);
      return indexDifference || left.localeCompare(right);
    });
}
