import { createSignal, For, type JSX, Show } from "solid-js";
import type { Attachment } from "../../lib/api";
import type { ContentBlock } from "../../lib/content-blocks";
import { IconChevronRight } from "../../ui/icons";
import { ImageWithPlaceholder } from "../AttachmentPreview";
import { FlagBlock } from "./blocks/FlagBlock";
import { TextBlock } from "./blocks/TextBlock";
import { ThinkingRow } from "./blocks/ThinkingRow";
import { ToolUseRow } from "./blocks/ToolUseRow";
import { tryRenderToolResult } from "./blocks/tool-result-renderers";

interface AIMessageContentProps {
  blocks: ContentBlock[];
  // Optional map from tool_use id → tool_result block from a *later* message.
  // The Anthropic shape emits tool_use on the assistant side and the matching
  // tool_result on the next user-role message, so pairing happens at the thread
  // level, not within one message.
  resolveToolResult?: (toolUseId: string) => ContentBlock | undefined;
  // User-authored messages render text blocks as plain text rather than
  // markdown, matching how Claude.ai / ChatGPT treat human input.
  isUserMessage?: boolean;
  // Stored image attachments keyed by the top-level content index (as a string)
  // of the image block they came from. When an image block's index is present,
  // the real image renders inline in place of the metadata placeholder.
  inlineImages?: ReadonlyMap<string, Attachment>;
}

// Claude.ai's export puts tool_use and tool_result blocks in the same message
// but leaves `id`/`tool_use_id` set to null, so the thread-wide resolver can't
// pair them. Fall back to positional pairing: each id-less tool_use takes the
// next unpaired tool_result in the same blocks array.
function pairToolUsesByPosition(
  blocks: ContentBlock[]
): { positional: Map<number, ContentBlock>; paired: Set<number> } {
  const positional = new Map<number, ContentBlock>();
  const paired = new Set<number>();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== "tool_use" || b.id) continue;
    for (let j = i + 1; j < blocks.length; j++) {
      if (paired.has(j)) continue;
      if (blocks[j].type === "tool_result") {
        positional.set(i, blocks[j]);
        paired.add(j);
        break;
      }
    }
  }
  return { positional, paired };
}

export function AIMessageContent(props: AIMessageContentProps): JSX.Element {
  const pairing = () => pairToolUsesByPosition(props.blocks);

  const renderable = () => {
    const { paired } = pairing();
    const resolved = props.resolveToolResult;
    return props.blocks
      .map((block, index) => ({ block, index }))
      .filter(({ block, index }) => {
        if (block.type !== "tool_result") return true;
        if (paired.has(index)) return false;
        const id = block.tool_use_id;
        return !id || !resolved || resolved(id) === undefined;
      });
  };

  const resultFor = (index: number, block: ContentBlock): ContentBlock | undefined => {
    const { positional } = pairing();
    const pos = positional.get(index);
    if (pos) return pos;
    const id = block.id;
    if (id && props.resolveToolResult) return props.resolveToolResult(id);
    return undefined;
  };

  return (
    <div class="space-y-1">
      <For each={renderable()}>
        {({ block, index }) => (
          <BlockRow
            block={block}
            result={block.type === "tool_use" ? resultFor(index, block) : undefined}
            isUserMessage={props.isUserMessage}
            inlineImage={props.inlineImages?.get(String(index))}
          />
        )}
      </For>
    </div>
  );
}

function BlockRow(props: {
  block: ContentBlock;
  result: ContentBlock | undefined;
  isUserMessage?: boolean;
  // The stored image attachment matching this block's top-level position, if
  // any. Present only for top-level image blocks with a stored image row.
  inlineImage?: Attachment;
}): JSX.Element {
  switch (props.block.type) {
    case "text":
      return props.block.text ? (
        <TextBlock
          text={props.block.text}
          citations={props.block.citations}
          asPlainText={props.isUserMessage}
        />
      ) : (
        <></>
      );
    case "thinking":
      return <ThinkingRow block={props.block} />;
    case "tool_use":
      return <ToolUseRow block={props.block} result={props.result} />;
    case "tool_result":
      // Orphaned result (no matching tool_use found in the thread).
      return <OrphanToolResult block={props.block} />;
    case "flag":
      return <FlagBlock block={props.block} />;
    case "summary":
      // A compaction summary with text renders like any other message text.
      // Thread-level summaries carry only a reference, so fall back to a small
      // placeholder naming the referenced thread.
      return props.block.text ? (
        <TextBlock text={props.block.text} asPlainText={props.isUserMessage} />
      ) : props.block.thread_id ? (
        <div class="text-sm text-muted-foreground italic">
          Summary of thread {props.block.thread_id}
        </div>
      ) : (
        <></>
      );
    case "image": {
      const inline = props.inlineImage;
      // A stored image attachment for this block renders inline in place of the
      // metadata placeholder, so a pasted screenshot appears where it was.
      if (inline) {
        return (
          <div class="max-w-sm my-1">
            <ImageWithPlaceholder attachment={inline} />
          </div>
        );
      }
      // Metadata-only placeholder — the base64 bytes are never surfaced here.
      return (
        <div class="text-sm text-muted-foreground italic">
          {props.block.media_type ? `Image (${props.block.media_type})` : "Image"}
        </div>
      );
    }
    default:
      return <></>;
  }
}

function OrphanToolResult(props: { block: ContentBlock }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const text = () => {
    const c = props.block.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const parts: string[] = [];
      for (const item of c) {
        if (item && typeof item === "object") {
          const obj = item as { type?: unknown; text?: unknown };
          if (obj.type === "text" && typeof obj.text === "string") {
            parts.push(obj.text);
            continue;
          }
        }
        if (typeof item === "string") parts.push(item);
        else parts.push(JSON.stringify(item, null, 2));
      }
      return parts.join("\n");
    }
    if (c === null || c === undefined) return null;
    return JSON.stringify(c, null, 2);
  };
  const name = () => (typeof props.block.name === "string" ? props.block.name : "");
  const rich = () => tryRenderToolResult(name(), props.block);
  const hasBody = () => Boolean(props.block.error) || rich() !== null || text() !== null;

  return (
    <div class="text-sm">
      <button
        type="button"
        class={`group flex items-center gap-2 text-left w-full px-1.5 py-0.5 rounded transition-colors ${
          hasBody() ? "cursor-pointer hover:bg-muted/50" : "cursor-default"
        } ${expanded() ? "bg-muted/40" : ""}`}
        onClick={() => hasBody() && setExpanded(!expanded())}
        disabled={!hasBody()}
      >
        <span class="font-medium text-muted-foreground uppercase tracking-wide text-xs shrink-0">
          Tool result{props.block.error ? " (error)" : ""}
        </span>
        <Show when={name()}>
          <span class="font-mono text-muted-foreground/90 truncate min-w-0 flex-1">
            {name()}
          </span>
        </Show>
        <Show when={hasBody()}>
          <OrphanChevron expanded={expanded()} />
        </Show>
      </button>
      <Show when={expanded() && hasBody()}>
        <div class="px-3 pb-2 pt-0">
          <Show when={props.block.error}>
            {(err) => (
              <pre class="whitespace-pre-wrap break-words text-red-900 dark:text-red-200 text-sm">
                {err()}
              </pre>
            )}
          </Show>
          <Show
            when={rich()}
            fallback={
              <Show when={text()}>
                <pre class="whitespace-pre-wrap break-words text-sm">{text()}</pre>
              </Show>
            }
          >
            {(r) => <div class="text-sm">{r()}</div>}
          </Show>
        </div>
      </Show>
    </div>
  );
}

function OrphanChevron(props: { expanded: boolean }): JSX.Element {
  return (
    <IconChevronRight
      class={`w-3 h-3 shrink-0 text-muted-foreground transition-opacity ${
        props.expanded ? "opacity-100 rotate-90" : "opacity-0 group-hover:opacity-60"
      }`}
      aria-hidden="true"
    />
  );
}
