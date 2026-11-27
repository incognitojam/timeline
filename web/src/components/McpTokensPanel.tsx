import { useQueryClient } from "@tanstack/solid-query";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { createMcpToken, type McpToken } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { formatAbsoluteTime, timestampToBrowserIso } from "../lib/mcp-format";
import { queryKeys, useMcpTokens, useRevokeMcpToken } from "../lib/queries";
import Dialog from "../ui/Dialog";
import { IconCheck, IconCopy } from "../ui/icons";

export const BUTTON = "rounded-sm border border-border px-3 py-1.5 text-sm text-foreground transition-colors enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const PRIMARY_BUTTON = "rounded-sm bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors enabled:hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export const DESTRUCTIVE_BUTTON = "rounded-sm bg-destructive px-3.5 py-1.5 text-sm font-medium text-destructive-foreground transition-colors enabled:hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const BADGE = "inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground";

export function When(props: { at: string }) {
  return <span title={formatAbsoluteTime(props.at)}>{formatRelativeTime(timestampToBrowserIso(props.at))}</span>;
}

/** The token just created: shown until dismissed, never fetched again. */
function NewToken(props: { label: string; token: string; onDone: () => void }) {
  const [copied, setCopied] = createSignal<boolean | null>(null);
  async function copy() {
    await navigator.clipboard.writeText(props.token).then(() => setCopied(true), () => setCopied(false));
  }
  return (
    <div role="status" class="rounded-lg border border-primary/40 bg-primary/5 p-4">
      <p class="text-sm font-medium [overflow-wrap:anywhere]">Token for {props.label}</p>
      <p class="mt-1 text-xs text-muted-foreground">
        Copy it now: it is not stored and will not be shown again. Send it as <code>Authorization: Bearer &lt;token&gt;</code>.
      </p>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <code data-testid="new-mcp-token" class="min-w-0 flex-1 break-all rounded-sm bg-muted px-2 py-1.5 font-mono text-xs">{props.token}</code>
        <button type="button" class={`${BUTTON} inline-flex items-center gap-1.5`} onClick={() => void copy()}>
          <Show when={copied()} fallback={<IconCopy class="h-4 w-4" />}><IconCheck class="h-4 w-4" /></Show>
          {copied() ? "Copied" : "Copy"}
        </button>
        <button type="button" class={BUTTON} onClick={() => props.onDone()}>Done</button>
      </div>
      <Show when={copied() === false}>
        <p role="alert" class="mt-2 text-xs text-destructive">Could not copy. Select the token and copy it.</p>
      </Show>
    </div>
  );
}

function CreateForm(props: { onCreated: (label: string, token: string) => void }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [label, setLabel] = createSignal("");
  const [readOnly, setReadOnly] = createSignal(false);
  const [tailnetOnly, setTailnetOnly] = createSignal(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const name = label().trim();
    setPending(true);
    setError(null);
    try {
      const { token } = await createMcpToken({ label: name, read_only: readOnly(), tailnet_only: tailnetOnly() });
      setLabel("");
      setReadOnly(false);
      setTailnetOnly(false);
      props.onCreated(name, token);
      void queryClient.invalidateQueries({ queryKey: queryKeys.mcpTokens() });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <form class="flex flex-wrap items-end gap-x-4 gap-y-3" onSubmit={(event) => void submit(event)}>
      <label class="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
        Label
        <input
          class="rounded-sm border border-border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={label()}
          onInput={(event) => setLabel(event.currentTarget.value)}
          placeholder="e.g. claude-ai"
          required
        />
      </label>
      <label class="flex items-center gap-2 py-1.5 text-sm" title="Not offered the tools that change anything">
        <input type="checkbox" checked={readOnly()} onChange={(event) => setReadOnly(event.currentTarget.checked)} />
        Read-only
      </label>
      <label class="flex items-center gap-2 py-1.5 text-sm" title="Refused over public access (Funnel)">
        <input type="checkbox" checked={tailnetOnly()} onChange={(event) => setTailnetOnly(event.currentTarget.checked)} />
        Tailnet only
      </label>
      <button type="submit" class={PRIMARY_BUTTON} disabled={pending() || !label().trim()} aria-describedby="mcp-token-label-hint">Create token</button>
      <Show when={!label().trim()}>
        <p id="mcp-token-label-hint" class="w-full -mt-1 text-xs text-muted-foreground">Enter a label to create a token, such as the client that will use it.</p>
      </Show>
      <Show when={error()}>
        {(message) => <p role="alert" class="w-full text-xs text-destructive">{message()}</p>}
      </Show>
    </form>
  );
}

function TokenRow(props: { token: McpToken; onRevoke: () => void }) {
  return (
    <li class={`flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 ${props.token.revoked_at ? "opacity-60" : ""}`}>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="font-medium [overflow-wrap:anywhere]">{props.token.label}</span>
          <span class={BADGE}>{props.token.read_only ? "read-only" : "full access"}</span>
          <Show when={props.token.tailnet_only}><span class={BADGE}>tailnet only</span></Show>
          <Show when={props.token.revoked_at}>{(at) => <span class={BADGE}>revoked <When at={at()} /></span>}</Show>
        </div>
        <div class="mt-1 text-xs text-muted-foreground">
          Created <When at={props.token.created_at} /> ·{" "}
          <Show when={props.token.last_used_at} fallback="never used">
            {(at) => <>last used <When at={at()} /></>}
          </Show>
          <Show when={props.token.last_client}>{(client) => <> by <span class="[overflow-wrap:anywhere]">{client()}</span></>}</Show>
        </div>
      </div>
      <Show when={!props.token.revoked_at}>
        <button type="button" class={BUTTON} onClick={() => props.onRevoke()}>Revoke</button>
      </Show>
    </li>
  );
}

export default function McpTokensPanel() {
  const query = useMcpTokens();
  const revoke = useRevokeMcpToken();
  const [created, setCreated] = createSignal<{ label: string; token: string } | null>(null);
  const [revoking, setRevoking] = createSignal<McpToken | null>(null);
  // Drop a shown token when the page is left, so Back cannot bring it back.
  const forget = () => setCreated(null);
  window.addEventListener("pagehide", forget);
  onCleanup(() => window.removeEventListener("pagehide", forget));

  function askRevoke(token: McpToken) {
    revoke.reset();
    setRevoking(token);
  }

  async function confirmRevoke(token: McpToken) {
    await revoke.mutateAsync(token.id);
    if (revoking()?.id === token.id) setRevoking(null);
  }

  return (
    <section class="mb-8" aria-labelledby="mcp-tokens-heading">
      <h2 id="mcp-tokens-heading" class="font-display text-lg font-medium">Tokens</h2>
      <p class="mt-1 mb-4 text-sm text-muted-foreground">
        Clients connect to <code>/mcp</code> with a token. Revoking one stops it on its next request.
      </p>

      <div class="space-y-4">
        <Show when={created()} fallback={<CreateForm onCreated={(label, token) => setCreated({ label, token })} />}>
          {(fresh) => <NewToken label={fresh().label} token={fresh().token} onDone={() => setCreated(null)} />}
        </Show>

        <Show when={query.isError}>
          <div class="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">Failed to load MCP tokens.</div>
        </Show>

        <Show when={query.data}>
          {(data) => (
            <>
              <Show
                when={data().tokens.length > 0}
                fallback={<div class="rounded-lg bg-card p-4 text-sm text-muted-foreground">No tokens created here yet.</div>}
              >
                <ul class="divide-y divide-border rounded-lg border border-border">
                  <For each={data().tokens}>{(token) => <TokenRow token={token} onRevoke={() => askRevoke(token)} />}</For>
                </ul>
              </Show>
              <Show when={data().env_token_count > 0}>
                <p class="text-xs text-muted-foreground">
                  {data().env_token_count === 1 ? "1 token" : `${data().env_token_count} tokens`} from <code>MCP_TOKENS</code> in the env file, with full access, not listed here.
                </p>
              </Show>
            </>
          )}
        </Show>
      </div>

      <Dialog open={revoking() !== null} onClose={() => setRevoking(null)} title="Revoke this token?">
        <Show when={revoking()}>
          {(token) => (
            <>
              <p class="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                Clients using “{token().label}” will be refused from their next request, including sessions already open. This cannot be undone.
              </p>
              <Show when={revoke.error}>
                {(error) => <p role="alert" class="mt-3 text-xs text-destructive">{error().message}</p>}
              </Show>
              <div class="mt-5 flex justify-end gap-2">
                <button type="button" class={BUTTON} onClick={() => setRevoking(null)}>Cancel</button>
                <button type="button" class={DESTRUCTIVE_BUTTON} disabled={revoke.isPending} onClick={() => void confirmRevoke(token()).catch(() => {})}>
                  Revoke
                </button>
              </div>
            </>
          )}
        </Show>
      </Dialog>
    </section>
  );
}
