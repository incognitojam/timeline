import type { DiscordRawAttachment } from "@shared/discord-forward";
import { For } from "solid-js";
import { Dynamic } from "solid-js/web";
import { formatFileSize, getFileIcon } from "../../lib/format";

/** Metadata fallback for Discord files that have not been stored locally. */
export function DiscordAttachmentFallback(props: { attachments: DiscordRawAttachment[] }) {
  return (
    <div class="flex flex-wrap gap-2 mt-2">
      <For each={props.attachments}>
        {(attachment) => (
          <div class="flex items-center gap-2 px-3 py-2 rounded-md bg-muted/50 border border-border/50 text-sm">
            <Dynamic
              component={getFileIcon(attachment.filename)}
              class="h-4 w-4 shrink-0"
              aria-hidden
            />
            <div class="min-w-0">
              <div class="truncate max-w-48 font-medium" title={attachment.filename}>
                {attachment.filename}
              </div>
              <div class="text-sm text-muted-foreground">
                {formatFileSize(attachment.size)}
              </div>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
