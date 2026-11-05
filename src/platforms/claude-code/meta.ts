import { claudeMeta } from "../claude/meta";
import type { PlatformMeta } from "../types";

export const claudeCodeMeta = {
  id: "claude-code",
  color: claudeMeta.color,
  sources: [
    {
      id: "claude-code",
      label: "Claude Code",
      eventTypes: ["claude-code:message:user", "claude-code:message:assistant"],
    },
  ],
  identityPlatforms: ["claude-code"],
} as const satisfies PlatformMeta;
