import { For, type JSX, Show } from "solid-js";
import { sourceLabel } from "@shared/sources";
import type { AggregatedAIMeta } from "../../lib/ai-events";
import { buildCliResumeCommand } from "../../lib/ai-events";
import { useCodingProject } from "../../lib/queries";
import { Markdown } from "../Markdown";

interface AISidebarPanelProps {
  aggregated: AggregatedAIMeta;
}

export function AISidebarPanel(props: AISidebarPanelProps): JSX.Element {
  const resume = () => buildCliResumeCommand(props.aggregated);

  const workspace = () => props.aggregated.workspace ?? "";
  const projectQuery = useCodingProject(workspace);
  const projectMatch = () =>
    projectQuery.isPending || projectQuery.isLoadingError || !projectQuery.data
      ? null
      : workspace();

  return (
    <div class="space-y-6 p-4">
      <Overview aggregated={props.aggregated} />
      <Summary aggregated={props.aggregated} />
      <Context aggregated={props.aggregated} projectMatch={projectMatch()} />
      <Usage aggregated={props.aggregated} />
      <ToolUsage toolUsage={props.aggregated.toolUsage} />
      <FinishReasons reasons={props.aggregated.finishReasons} />
      <Actions resume={resume()} />
    </div>
  );
}

function Summary(props: { aggregated: AggregatedAIMeta }): JSX.Element {
  return (
    <Show when={props.aggregated.conversationSummary}>
      {(summary) => (
        <div class="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-pre:my-1 prose-pre:text-xs prose-code:text-xs text-sm text-muted-foreground">
          <Markdown markdown={summary()} />
        </div>
      )}
    </Show>
  );
}

function Section(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <div>
      <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
        {props.title}
      </h3>
      {props.children}
    </div>
  );
}

function Row(props: { label: string; children: JSX.Element; title?: string }): JSX.Element {
  return (
    <div class="flex justify-between gap-3 items-baseline">
      <span class="text-muted-foreground shrink-0">{props.label}</span>
      <span class="font-medium text-right truncate min-w-0" title={props.title}>
        {props.children}
      </span>
    </div>
  );
}

function Overview(props: { aggregated: AggregatedAIMeta }): JSX.Element {
  const agg = () => props.aggregated;
  const durationMs = () => {
    const f = agg().firstTimestamp;
    const l = agg().lastTimestamp;
    if (!f || !l) return null;
    return new Date(l).getTime() - new Date(f).getTime();
  };

  return (
    <Section title="Session">
      <div class="space-y-2 text-sm">
        <Row label="Source">{sourceLabel(agg().source)}</Row>
        <Row label="Messages">{agg().messageCount.toLocaleString()}</Row>
        <Show when={durationMs()}>
          {(ms) => <Row label="Span">{formatSpan(ms())}</Row>}
        </Show>
        <Show when={agg().sessionIds.length > 0}>
          <Row label="Session" title={agg().sessionIds[0]}>
            <code class="text-xs">{shortId(agg().sessionIds[0])}</code>
          </Row>
        </Show>
        <Show when={agg().sessionIds.length > 1}>
          <Row label="Sessions">{agg().sessionIds.length}</Row>
        </Show>
        <Show when={agg().totalAttachments > 0}>
          <Row label="Attachments">
            {agg().totalAttachments.toLocaleString()}
            <span class="text-muted-foreground ml-1">
              ({agg().messagesWithAttachments} msg)
            </span>
          </Row>
        </Show>
      </div>
    </Section>
  );
}

function Context(props: { aggregated: AggregatedAIMeta; projectMatch: string | null | undefined }): JSX.Element {
  const agg = () => props.aggregated;
  const anyContext = () =>
    agg().workspace || agg().cwd || agg().gitBranch || agg().agent || agg().mode;

  return (
    <Show when={anyContext()}>
      <Section title="Workspace">
        <div class="space-y-2 text-sm">
          <Show when={agg().workspace}>
            {(w) => (
              <Row label="Workspace" title={agg().cwd ?? undefined}>
                <Show when={props.projectMatch} fallback={w()}>
                  {(match) => (
                    <a
                      href={`/coding/project/${encodeURIComponent(match())}`}
                      class="text-primary hover:underline"
                    >
                      {w()}
                    </a>
                  )}
                </Show>
              </Row>
            )}
          </Show>
          <Show when={agg().gitBranch}>
            {(b) => (
              <Row label="Branch" title={b()}>
                <code class="text-xs">{b()}</code>
              </Row>
            )}
          </Show>
          <Show when={agg().cwd}>
            {(p) => (
              <Row label="Path" title={p()}>
                <code class="text-xs truncate">{p()}</code>
              </Row>
            )}
          </Show>
          <Show when={agg().agent}>{(a) => <Row label="Agent">{a()}</Row>}</Show>
          <Show when={agg().mode}>{(m) => <Row label="Mode">{m()}</Row>}</Show>
        </div>
      </Section>
    </Show>
  );
}

function Usage(props: { aggregated: AggregatedAIMeta }): JSX.Element {
  const agg = () => props.aggregated;
  const hasTokens = () =>
    agg().totalInputTokens +
      agg().totalOutputTokens +
      agg().totalCacheReadTokens +
      agg().totalCacheWriteTokens +
      agg().totalReasoningTokens >
    0;
  const hasCost = () => agg().totalCost > 0 || agg().totalCredits > 0;
  const hasModel = () => agg().models.length > 0;

  return (
    <Show when={hasTokens() || hasCost() || hasModel()}>
      <Section title="Usage">
        <div class="space-y-2 text-sm">
          <Show when={hasModel()}>
            <div>
              <div class="text-muted-foreground mb-1">Model</div>
              <div class="space-y-1">
                <For each={agg().models}>
                  {(m) => (
                    <div class="flex justify-between gap-3">
                      <code class="text-xs truncate" title={m.model}>
                        {m.model}
                      </code>
                      <Show when={agg().models.length > 1}>
                        <span class="text-muted-foreground text-xs shrink-0">×{m.count}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <Show when={agg().totalInputTokens > 0}>
            <Row label="Input">{agg().totalInputTokens.toLocaleString()}</Row>
          </Show>
          <Show when={agg().totalOutputTokens > 0}>
            <Row label="Output">{agg().totalOutputTokens.toLocaleString()}</Row>
          </Show>
          <Show when={agg().totalCacheReadTokens > 0}>
            <Row label="Cache read">{agg().totalCacheReadTokens.toLocaleString()}</Row>
          </Show>
          <Show when={agg().totalCacheWriteTokens > 0}>
            <Row label="Cache write">{agg().totalCacheWriteTokens.toLocaleString()}</Row>
          </Show>
          <Show when={agg().totalReasoningTokens > 0}>
            <Row label="Reasoning">{agg().totalReasoningTokens.toLocaleString()}</Row>
          </Show>
          <Show when={agg().totalCost > 0}>
            <Row label="Cost">${agg().totalCost.toFixed(4)}</Row>
          </Show>
          <Show when={agg().totalCredits > 0}>
            <Row label="Credits">{agg().totalCredits.toFixed(2)}</Row>
          </Show>
        </div>
      </Section>
    </Show>
  );
}

function ToolUsage(props: { toolUsage: Record<string, number> }): JSX.Element {
  const entries = () =>
    Object.entries(props.toolUsage).sort((a, b) => b[1] - a[1]);
  return (
    <Show when={entries().length > 0}>
      <Section title="Tools">
        <div class="space-y-1 text-sm">
          <For each={entries()}>
            {([name, count]) => (
              <div class="flex justify-between">
                <span class="text-muted-foreground truncate">{name}</span>
                <span class="font-medium">{count.toLocaleString()}</span>
              </div>
            )}
          </For>
        </div>
      </Section>
    </Show>
  );
}

function FinishReasons(
  props: { reasons: AggregatedAIMeta["finishReasons"] }
): JSX.Element {
  return (
    <Show when={props.reasons.length > 0}>
      <Section title="Finish">
        <div class="space-y-1 text-sm">
          <For each={props.reasons}>
            {(r) => (
              <div class="flex justify-between">
                <span class="text-muted-foreground truncate">{r.reason}</span>
                <span class="font-medium">{r.count.toLocaleString()}</span>
              </div>
            )}
          </For>
        </div>
      </Section>
    </Show>
  );
}

function Actions(
  props: { resume: ReturnType<typeof buildCliResumeCommand> }
): JSX.Element {
  return (
    <Show when={props.resume}>
      {(resume) => (
        <Section title="Actions">
          <ResumeButton action={resume()} />
        </Section>
      )}
    </Show>
  );
}

function ResumeButton(props: {
  action: NonNullable<ReturnType<typeof buildCliResumeCommand>>;
}): JSX.Element {
  const buttonClass =
    "w-full px-3 py-2 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer text-center block";

  return (
    <div class="space-y-2">
      <Show
        when={props.action.kind === "url"}
        fallback={
          <button
            type="button"
            class={buttonClass}
            onClick={() => {
              navigator.clipboard.writeText(props.action.command).catch(() => {});
            }}
            title={props.action.command}
          >
            {props.action.label}
          </button>
        }
      >
        <a
          href={props.action.command}
          target="_blank"
          rel="noopener noreferrer"
          class={buttonClass}
          title={props.action.command}
        >
          {props.action.label}
        </a>
      </Show>
      <code class="block text-xs text-muted-foreground truncate" title={props.action.command}>
        {props.action.command}
      </code>
    </div>
  );
}

function formatSpan(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function shortId(id: string | undefined): string {
  if (!id) return "";
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…`;
}
