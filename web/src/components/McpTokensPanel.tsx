import { useQueryClient } from "@tanstack/solid-query";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createMcpToken, type McpToken } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { formatAbsoluteTime, timestampToBrowserIso } from "../lib/mcp-format";
import { queryKeys, useMcpTokens, useRevokeMcpToken } from "../lib/queries";
import Dialog from "../ui/Dialog";
import { IconAdd } from "../ui/icons";
import McpConnectGuide, { ConnectSteps, CopyValue } from "./McpConnectGuide";

export const BUTTON = "rounded-sm border border-border px-3 py-1.5 text-sm text-foreground transition-colors enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const PRIMARY_BUTTON = "rounded-sm bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors enabled:hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export const DESTRUCTIVE_BUTTON = "rounded-sm bg-destructive px-3.5 py-1.5 text-sm font-medium text-destructive-foreground transition-colors enabled:hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const BADGE = "inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground";

export function When(props: { at: string }) {
  return <span title={formatAbsoluteTime(props.at)}>{formatRelativeTime(timestampToBrowserIso(props.at))}</span>;
}

interface Created { label: string; token: string; readOnly: boolean; tailnetOnly: boolean }

/** The token just created, with the steps to connect it: shown once, never fetched again. */
function NewToken(props: { created: Created; onDone: () => void }) {
  let copyButton: HTMLButtonElement | undefined;
  // Masked by default so a screen share or screenshot does not show it; never kept beyond this dialog.
  const [revealed, setRevealed] = createSignal(false);
  // The form that had focus is gone; start on the token, the one thing to do now.
  onMount(() => copyButton?.focus());
  return (
    <>
      <div class="flex flex-wrap items-center gap-1.5 text-sm">
        <span class="font-medium [overflow-wrap:anywhere]">{props.created.label}</span>
        <span class={BADGE}>{props.created.readOnly ? "read-only" : "full access"}</span>
        <Show when={props.created.tailnetOnly}><span class={BADGE}>tailnet only</span></Show>
      </div>
      <p id="mcp-new-token-warning" class="mt-2 text-sm text-muted-foreground"><span class="sr-only">Token created. </span>Copy it now. You won't be able to see it again.</p>
      <CopyValue
        value={props.created.token}
        secret={props.created.token}
        revealed={revealed()}
        name="token"
        testId="new-mcp-token"
        describedBy="mcp-new-token-warning"
        ref={(button) => { copyButton = button; }}
      >
        <button type="button" class={BUTTON} aria-label={`${revealed() ? "Hide" : "Show"} token`} onClick={() => setRevealed(!revealed())}>
          {revealed() ? "Hide" : "Show"}
        </button>
      </CopyValue>
      <h3 class="mt-6 mb-3 font-medium">{props.created.tailnetOnly ? "Connect a client on your tailnet" : "Connect claude.ai"}</h3>
      <ConnectSteps token={props.created.token} tailnetOnly={props.created.tailnetOnly} revealed={revealed()} />
      <div class="mt-6 flex justify-end">
        <button type="button" class={PRIMARY_BUTTON} onClick={() => props.onDone()}>Done</button>
      </div>
    </>
  );
}

const LABEL_MISSING = "Enter a label.";

function CreateForm(props: { onCreated: (created: Created) => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [label, setLabel] = createSignal("");
  const [readOnly, setReadOnly] = createSignal(false);
  const [tailnetOnly, setTailnetOnly] = createSignal(false);
  let input: HTMLInputElement | undefined;

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    // Not disabled while pending: a disabled button would drop keyboard focus.
    if (pending()) return;
    const name = label().trim();
    if (!name) {
      setError(LABEL_MISSING);
      input?.focus();
      return;
    }
    setPending(true);
    setError(null);
    try {
      const options = { readOnly: readOnly(), tailnetOnly: tailnetOnly() };
      const { token } = await createMcpToken({ label: name, read_only: options.readOnly, tailnet_only: options.tailnetOnly });
      props.onCreated({ label: name, token, ...options });
      void queryClient.invalidateQueries({ queryKey: queryKeys.mcpTokens() });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPending(false);
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)}>
      <label class="block text-sm font-medium" for="mcp-token-label">Label</label>
      <input
        id="mcp-token-label"
        ref={input}
        class="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={label()}
        onInput={(event) => {
          setLabel(event.currentTarget.value);
          if (error() === LABEL_MISSING) setError(null);
        }}
        placeholder="e.g. claude-ai"
        aria-describedby={error() ? "mcp-token-label-hint mcp-token-error" : "mcp-token-label-hint"}
        aria-invalid={error() === LABEL_MISSING || undefined}
        required
      />
      <p id="mcp-token-label-hint" class="mt-1 text-xs text-muted-foreground">Names the token in the list, such as the client that will use it.</p>

      <fieldset class="mt-4 space-y-3">
        <legend class="sr-only">Options</legend>
        <div class="flex items-start gap-2 text-sm">
          <input id="mcp-token-read-only" type="checkbox" class="mt-1" checked={readOnly()} onChange={(event) => setReadOnly(event.currentTarget.checked)} aria-describedby="mcp-token-read-only-hint" />
          <div>
            <label for="mcp-token-read-only">Read-only</label>
            <p id="mcp-token-read-only-hint" class="text-xs text-muted-foreground">Not offered the tools that save or delete memory notes. Tick it for claude.ai unless it should save notes.</p>
          </div>
        </div>
        <div class="flex items-start gap-2 text-sm">
          <input id="mcp-token-tailnet-only" type="checkbox" class="mt-1" checked={tailnetOnly()} onChange={(event) => setTailnetOnly(event.currentTarget.checked)} aria-describedby="mcp-token-tailnet-hint" />
          <div>
            <label for="mcp-token-tailnet-only">Tailnet only</label>
            <p id="mcp-token-tailnet-hint" class="text-xs text-muted-foreground">Refused over public access, so claude.ai cannot use it. Tick it for a client on your tailnet or on the Mac running Timeline.</p>
          </div>
        </div>
      </fieldset>

      <Show when={error()}>
        {(message) => <p id="mcp-token-error" role="alert" class="mt-4 text-xs text-destructive">{message()}</p>}
      </Show>
      <div class="mt-6 flex justify-end gap-2">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>Cancel</button>
        <button type="submit" class={PRIMARY_BUTTON} aria-disabled={pending()}>{pending() ? "Creating…" : "Create token"}</button>
      </div>
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
  const [creating, setCreating] = createSignal(false);
  // The new token lives only while the dialog is open.
  const [created, setCreated] = createSignal<Created | null>(null);
  const [revoking, setRevoking] = createSignal<McpToken | null>(null);
  const closeCreate = () => {
    setCreating(false);
    setCreated(null);
  };
  // A create that finishes after the dialog closed is not shown: its token is in the list to revoke.
  const showCreated = (fresh: Created) => {
    if (creating()) setCreated(fresh);
  };
  // Drop a shown token when the page is left, so Back cannot bring it back.
  window.addEventListener("pagehide", closeCreate);
  onCleanup(() => window.removeEventListener("pagehide", closeCreate));

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
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="mcp-tokens-heading" class="font-display text-lg font-medium">Tokens</h2>
        <button type="button" class={`${PRIMARY_BUTTON} inline-flex items-center gap-1.5`} onClick={() => setCreating(true)}>
          <IconAdd class="h-4 w-4" />
          Create token
        </button>
      </div>
      <p class="mt-1 mb-4 text-sm text-muted-foreground">
        Clients connect to <code>/mcp</code> with a token. Revoking one stops it on its next request.
      </p>

      <div class="space-y-4">
        <McpConnectGuide />

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

      <Dialog open={creating()} onClose={closeCreate} title={created() ? "Token created" : "Create a token"} class="max-w-xl">
        <Show when={created()} fallback={<CreateForm onCreated={showCreated} onCancel={closeCreate} />}>
          {(fresh) => <NewToken created={fresh()} onDone={closeCreate} />}
        </Show>
      </Dialog>

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
