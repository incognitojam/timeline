import type { PlatformMeta } from "../types";

export const githubMeta = {
  id: "github",
  color: "#8b949e",
  sources: [
    {
      id: "github",
      label: "GitHub",
      traits: { corpus: true },
      eventTypes: [
        "github:commit_comment",
        "github:create",
        "github:delete",
        "github:follow",
        "github:fork",
        "github:gist",
        "github:issue",
        "github:issue_comment",
        "github:member",
        "github:pr",
        "github:pr_comment",
        "github:pr_review",
        "github:public",
        "github:pull_request",
        "github:release",
        "github:star",
        "github:wiki",
      ],
    },
  ],
  identityPlatforms: ["github"],
} as const satisfies PlatformMeta;
