import { For, type JSX } from "solid-js";
import { parseDiscordMentions } from "../../lib/discord-mentions";
import {
  discordTimestampToDate,
  formatDiscordTimestamp,
  formatDiscordTimestampTooltip,
} from "../../lib/discord-timestamps";
import { getResolvedIdentity } from "../../lib/identities";
import { DiscordEmoji } from "./DiscordEmoji";

interface Props {
  content: string;
  rawData: unknown;
}

/** Resolve a Discord user id to a display name via the identity cache. */
export const discordUserResolver = (id: string) =>
  getResolvedIdentity(`discord:${id}`)?.name ?? null;

const MENTION_CLASS =
  "rounded-sm px-0.5 bg-blue-500/15 text-blue-700 dark:text-blue-300 font-medium";
const ROLE_MENTION_CLASS =
  "rounded-sm px-0.5 bg-purple-500/15 text-purple-700 dark:text-purple-300 font-medium";
const TIMESTAMP_CLASS = "rounded-sm px-0.5 bg-muted";

export function DiscordContent(props: Props): JSX.Element {
  const segments = () =>
    parseDiscordMentions(props.content, props.rawData, { user: discordUserResolver });

  return (
    <For each={segments()}>
      {(seg) => {
        switch (seg.kind) {
          case "text":
            return <>{seg.value}</>;
          case "user-mention":
            return <span class={MENTION_CLASS}>@{seg.name}</span>;
          case "channel-mention":
            return <span class={MENTION_CLASS}>#{seg.name}</span>;
          case "role-mention":
            return (
              <span class={ROLE_MENTION_CLASS}>
                @{seg.name ?? `role:${seg.id.slice(0, 4)}…`}
              </span>
            );
          case "custom-emoji":
            return <DiscordEmoji id={seg.id} name={seg.name} size="inline" />;
          case "timestamp":
            return (
              <time
                class={TIMESTAMP_CLASS}
                datetime={discordTimestampToDate(seg.seconds).toISOString()}
                title={formatDiscordTimestampTooltip(seg.seconds)}
              >
                {formatDiscordTimestamp(seg.seconds, seg.style)}
              </time>
            );
        }
      }}
    </For>
  );
}
