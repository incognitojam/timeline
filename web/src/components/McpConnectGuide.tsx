import { createSignal, createUniqueId, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import type { McpConnectInfo } from "../lib/api";
import { formatTime } from "../lib/format";
import { useMcpConnectInfo } from "../lib/queries";
import { IconCheck, IconChevronRight, IconCopy, IconWarning } from "../ui/icons";

const DOCS = "https://github.com/incognitojam/timeline/blob/main/docs/user";
const COPY_BUTTON = "inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const LINK = "underline underline-offset-2 hover:text-foreground";
const CODE = "min-w-0 break-all rounded-sm bg-muted px-2 py-1.5 font-mono text-xs text-foreground";
const PLACEHOLDER_URL = "https://<node>.ts.net/mcp";

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

/** How a secret shows until revealed: enough of the start to recognise it. Only this reaches the DOM. */
export function maskSecret(secret: string): string {
  return `${secret.slice(0, 8)}${"•".repeat(12)}`;
}

/**
 * A value with a button that copies it. `name` finishes the button's
 * accessible name ("Copy <name>"), and success or failure is announced.
 * With `secret`, that part of the value is masked unless `revealed`; the
 * copy is always the full value.
 */
export function CopyValue(props: {
  value: string;
  name: string;
  secret?: string;
  revealed?: boolean;
  testId?: string;
  describedBy?: string;
  ref?: (button: HTMLButtonElement) => void;
  children?: JSX.Element;
}) {
  const [copied, setCopied] = createSignal<boolean | null>(null);
  // "Copied" fades back to "Copy", so copying again is announced again.
  let reset: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(reset));
  const masked = () => props.secret !== undefined && !props.revealed;
  const noteId = createUniqueId();
  const shown = () => (props.secret !== undefined && masked() ? props.value.replace(props.secret, () => maskSecret(props.secret ?? "")) : props.value);
  async function copy() {
    clearTimeout(reset);
    setCopied(null);
    try {
      await navigator.clipboard.writeText(props.value);
      setCopied(true);
      reset = setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <code data-testid={props.testId} class={CODE} aria-hidden={masked() || undefined}>{shown()}</code>
      <Show when={masked()}><span id={noteId} class="sr-only">{`The ${props.name} is hidden. Copy copies it in full; Show token reveals it.`}</span></Show>
      <button type="button" ref={props.ref} class={COPY_BUTTON} aria-label={`Copy ${props.name}`} aria-describedby={[props.describedBy, masked() ? noteId : undefined].filter(Boolean).join(" ") || undefined} onClick={() => void copy()}>
        <Show when={copied()} fallback={<IconCopy class="h-4 w-4" />}><IconCheck class="h-4 w-4" /></Show>
        {copied() ? "Copied" : "Copy"}
      </button>
      {props.children}
      <span role="status" class="sr-only">{copied() ? `Copied ${props.name}` : ""}</span>
      <Show when={copied() === false}>
        <p role="alert" class="w-full text-xs text-destructive">
          Could not copy.{masked() ? " Show it, then select it and copy it." : ` Select the ${props.name} and copy it.`}
        </p>
      </Show>
    </div>
  );
}

/** A value to show; copyable only when it is real rather than a placeholder. */
function Value(props: { value: string; name: string; real: boolean; secret?: string; revealed?: boolean; testId?: string }) {
  return (
    <Show when={props.real} fallback={<div class="mt-2 flex"><code data-testid={props.testId} class={CODE}>{props.value}</code></div>}>
      <CopyValue value={props.value} name={props.name} secret={props.secret} revealed={props.revealed} testId={props.testId} />
    </Show>
  );
}

const HOW_REMOTE_ACCESS = `${DOCS}/macos-host.md#remote-access-tailnet-only`;

/** The menu bar app's public access record, in one line. */
function PublicAccessState(props: { access: McpConnectInfo["public_access"] }) {
  return (
    <Switch>
      <Match when={props.access.state === "on" && props.access}>
        {(on) => <p class="mt-1">Public access is on until {formatTime(on().until)}.</p>}
      </Match>
      <Match when={props.access.state === "off"}>
        <p role="status" class="mt-1 flex items-center gap-1.5 text-foreground">
          <IconWarning class="h-4 w-4 shrink-0 text-amber-500" />
          Public access is off.
        </p>
      </Match>
      <Match when={props.access.state === "unavailable"}>
        <RemoteAccessMissing />
      </Match>
    </Switch>
  );
}

function RemoteAccessMissing() {
  return (
    <p class="mt-1">
      Remote Access is not set up in the menu bar app (<a class={LINK} href={HOW_REMOTE_ACCESS} target="_blank" rel="noreferrer">how</a>).
    </p>
  );
}

/** One step: the action in the foreground, anything after it muted. */
function Step(props: { action: JSX.Element; children?: JSX.Element }) {
  return (
    <li>
      <span class="text-foreground">{props.action}</span>
      {props.children}
    </li>
  );
}

function UrlNote(props: { known: boolean }) {
  return (
    <Show when={!props.known}>
      <p class="mt-1">Copy URL in the menu bar app gives the address; add <code>/mcp</code>.</p>
    </Show>
  );
}

/**
 * How to connect a client: with `token`, the one just created, filled in
 * (masked unless `revealed`); without, placeholders. A tailnet-only token
 * gets only the steps that work for it.
 */
export function ConnectSteps(props: { token: string | null; tailnetOnly: boolean; revealed?: boolean }) {
  const query = useMcpConnectInfo();
  const url = () => (query.data ? mcpServerUrl(query.data.public_url) : null);
  const token = () => props.token ?? "<token>";
  const secret = () => props.token ?? undefined;

  const urlValue = () => (
    <>
      <Value value={url() ?? PLACEHOLDER_URL} name="URL" real={url() !== null} testId="mcp-server-url" />
      <UrlNote known={url() !== null || !query.data} />
    </>
  );

  const tailnet = () => (
    <>
      <p class="text-foreground">Point the client at this URL, or at <code>http://127.0.0.1:3001/mcp</code> on the Mac itself:</p>
      {urlValue()}
      {/* With the claude.ai steps, step 1 already says so. */}
      <Show when={props.tailnetOnly && query.data?.public_access.state === "unavailable"}><RemoteAccessMissing /></Show>
      <p class="mt-3 text-foreground">Have it send this header:</p>
      <Value value={`Authorization: Bearer ${token()}`} name="header" real={props.token !== null} secret={secret()} revealed={props.revealed} testId="mcp-tailnet-header" />
    </>
  );

  return (
    <div class="text-sm text-muted-foreground">
      <Show when={query.isError}>
        <p role="alert" class="mb-3 text-destructive">Failed to load connection details.</p>
      </Show>
      <Show
        when={!props.tailnetOnly}
        fallback={
          <>
            <p class="mb-3">claude.ai cannot use this token: it is refused over public access. Clients on your tailnet or on the Mac need no public access.</p>
            {tailnet()}
          </>
        }
      >
        <ol class="list-decimal space-y-3 pl-5 marker:text-muted-foreground">
          <Step action={<>Turn on public access in the menu bar app and wait until its menu reads just “public until …”.</>}>
            <Show when={query.data}>{(data) => <PublicAccessState access={data().public_access} />}</Show>
          </Step>
          <Step action="In claude.ai, add a custom connector with this URL:">
            {urlValue()}
          </Step>
          <Step action="Choose No sign-in.">
            <p class="mt-1">Sign in now will be tagged Detected; that's expected.</p>
          </Step>
          <Step action={<>Add an <code>authorization</code> header with this value:</>}>
            <Value value={`Bearer ${token()}`} name="header value" real={props.token !== null} secret={secret()} revealed={props.revealed} testId="mcp-header-value" />
          </Step>
          <Step action="Leave the rest as it is and press Add." />
        </ol>
        <p class="mt-3">
          Not connecting? See <a class={LINK} href={`${DOCS}/mcp.md#remote-http`} target="_blank" rel="noreferrer">what to check</a>.
        </p>
        <div class="mt-5">
          <h4 class="mb-1 font-medium text-foreground">Or a client on your tailnet</h4>
          <p class="mb-2">It needs no public access, and any token works, Tailnet only ones included.</p>
          {tailnet()}
        </div>
      </Show>
    </div>
  );
}

/** The steps for someone returning without a fresh token, folded away until asked for. */
export default function McpConnectGuide() {
  return (
    <details class="group rounded-lg border border-border">
      <summary class="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <IconChevronRight class="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" />
        Connect a client{" "}
        <span class="font-normal text-muted-foreground">to claude.ai or your tailnet</span>
      </summary>
      <div class="border-t border-border px-4 py-4">
        <p class="mb-4 text-sm text-muted-foreground">
          Create token shows these steps again with the new token filled in. The full guide is in the <a class={LINK} href={`${DOCS}/mcp.md#remote-http`} target="_blank" rel="noreferrer">MCP docs</a>.
        </p>
        <ConnectSteps token={null} tailnetOnly={false} />
      </div>
    </details>
  );
}
