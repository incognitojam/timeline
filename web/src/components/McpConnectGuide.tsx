import { createSignal, Match, Show, Switch } from "solid-js";
import type { McpConnectInfo } from "../lib/api";
import { formatTime } from "../lib/format";
import { useMcpConnectInfo } from "../lib/queries";
import { IconCheck, IconCopy, IconWarning } from "../ui/icons";

const DOCS = "https://github.com/incognitojam/timeline/blob/main/docs/user";
const BUTTON = "inline-flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const LINK = "underline underline-offset-2 hover:text-foreground";

/** An https `.ts.net` origin on the default port, which is what Funnel serves; null otherwise. */
function funnelOrigin(candidate: string | null): string | null {
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.port && url.hostname.endsWith(".ts.net") ? url.origin : null;
  } catch {
    return null;
  }
}

/** The `/mcp` URL at this page's tailnet address, else at the configured public URL; null when neither is one Funnel serves. */
export function mcpServerUrl(publicUrl: string | null, here: Location = window.location): string | null {
  const origin = funnelOrigin(here.origin) ?? funnelOrigin(publicUrl);
  return origin ? `${origin}/mcp` : null;
}

function PublicAccessState(props: { access: McpConnectInfo["public_access"] }) {
  return (
    <Switch>
      <Match when={props.access.state === "on" && props.access}>
        {(on) => (
          <p class="mt-1">
            The menu bar app has public access on until {formatTime(on().until)}. Its menu shows “public until …, checking…” while it checks that the address answers from the internet, then “public until …” once it does, or “not confirmed reachable”. Add the connector once it shows “public until …” alone. Public access ends by itself, and the connector then stops working until you turn it on again.
          </p>
        )}
      </Match>
      <Match when={props.access.state === "off"}>
        <p role="status" class="mt-2 flex items-start gap-1.5 rounded-sm border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-foreground">
          <IconWarning class="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          Public access is off, so claude.ai cannot reach Timeline yet.
        </p>
      </Match>
      <Match when={props.access.state === "unavailable"}>
        <p class="mt-1">
          The menu bar app has not set up Remote Access on the machine running the service, so this page cannot tell whether public access is on. Set it up from the menu bar app (<a class={LINK} href={`${DOCS}/macos-host.md#remote-access-tailnet-only`} target="_blank" rel="noreferrer">how</a>).
        </p>
      </Match>
    </Switch>
  );
}

export default function McpConnectGuide() {
  const query = useMcpConnectInfo();
  const [copied, setCopied] = createSignal<boolean | null>(null);
  const url = () => (query.data ? mcpServerUrl(query.data.public_url) : null);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section class="mb-8" aria-labelledby="mcp-connect-heading">
      <h2 id="mcp-connect-heading" class="font-display text-lg font-medium">Connect a client</h2>
      <p class="mt-1 mb-4 text-sm text-muted-foreground">
        For a hosted client such as a claude.ai custom connector. The full steps are in the <a class={LINK} href={`${DOCS}/mcp.md#remote-http`} target="_blank" rel="noreferrer">MCP guide</a>.
      </p>
      <Show when={query.isError}>
        <div class="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">Failed to load connection details.</div>
      </Show>
      <ol class="list-decimal space-y-3 pl-5 text-sm text-muted-foreground marker:text-foreground">
        <li>
          <span class="font-medium text-foreground">Turn on public access</span> in the menu bar app: <b>Remote Access → Make Public on the Internet</b> and a duration. claude.ai connects from Anthropic's servers, not your device; clients on your tailnet or this Mac don't need it. Allow a few minutes the first time: Tailscale says public DNS records can take up to 10 minutes to appear.
          <Show when={query.data}>{(data) => <PublicAccessState access={data().public_access} />}</Show>
        </li>
        <li>
          <span class="font-medium text-foreground">Create a token</span> below. For claude.ai leave <b>Tailnet only</b> unticked, since it is refused over public access, and tick <b>Read-only</b> unless it should save memory notes. Tick <b>Tailnet only</b> for clients on your tailnet or this Mac.
        </li>
        <li>
          <span class="font-medium text-foreground">In claude.ai</span>, open <b>Customize → Connectors</b>, choose <b>+ Add → Add custom connector</b> (on a Team or Enterprise plan an owner adds it under <b>Organization settings → Connectors</b>) and enter this URL:
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <code data-testid="mcp-server-url" class="min-w-0 break-all rounded-sm bg-muted px-2 py-1.5 font-mono text-xs text-foreground">{url() ?? "https://<node>.ts.net/mcp"}</code>
            <Show when={url()}>
              {(known) => (
                <button type="button" class={BUTTON} onClick={() => void copy(known())}>
                  <Show when={copied()} fallback={<IconCopy class="h-4 w-4" />}><IconCheck class="h-4 w-4" /></Show>
                  {copied() ? "Copied" : "Copy"}
                </button>
              )}
            </Show>
          </div>
          <Show when={query.data && !url()}>
            <p class="mt-1"><b>Copy URL</b> in the menu bar app gives the address; add <code>/mcp</code>.</p>
          </Show>
          <Show when={copied() === false}>
            <p role="alert" class="mt-1 text-xs text-destructive">Could not copy. Select the URL and copy it.</p>
          </Show>
          <p class="mt-2">
            After it checks the server, choose no sign-in, and under <b>Request headers</b> add <code>Authorization</code> with the value <code>Bearer &lt;token&gt;</code>. If the check says it couldn't reach the server and public access was only just turned on, wait a few minutes and try again, or choose <b>Continue anyway</b> if the URL is right. Still failing? See <a class={LINK} href={`${DOCS}/mcp.md#remote-http`} target="_blank" rel="noreferrer">what to check</a>.
          </p>
        </li>
      </ol>
    </section>
  );
}
