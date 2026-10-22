import { createSignal, For, Show } from "solid-js";
import type { RemoteAgentsConnectionTest } from "../lib/api";
import {
  useGenerateRemoteAgentsKey,
  useRemoteAgentsSsh,
  useTestRemoteAgentsConnection,
  useTrustRemoteAgentsHost,
} from "../lib/queries";
import { IconCopy } from "../ui/icons";

const buttonClass =
  "rounded-md border border-border px-3 py-1.5 text-sm transition-colors enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/**
 * SSH setup for the remote-agents source: Timeline's own key (shown only as
 * the authorized_keys line to install on the remote host) and the explicit
 * host-key trust step behind Test connection.
 */
export default function RemoteAgentsSshPanel() {
  const sshQuery = useRemoteAgentsSsh();
  const generate = useGenerateRemoteAgentsKey();
  const test = useTestRemoteAgentsConnection();
  const trust = useTrustRemoteAgentsHost();
  const [result, setResult] = createSignal<RemoteAgentsConnectionTest | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);

  // A connection result describes one host; hide it once the saved host changes.
  const currentResult = () => {
    const outcome = result();
    return outcome && outcome.host === sshQuery.data?.host?.label ? outcome : null;
  };
  const untrustedResult = () => {
    const outcome = currentResult();
    return outcome?.status === "untrusted" ? outcome : null;
  };
  const okResult = () => {
    const outcome = currentResult();
    return outcome?.status === "ok" ? outcome : null;
  };
  const errorResult = () => {
    const outcome = currentResult();
    return outcome?.status === "error" ? outcome : null;
  };

  const busy = () => generate.isPending || test.isPending || trust.isPending;

  async function runAction(action: () => Promise<RemoteAgentsConnectionTest | void>) {
    setActionError(null);
    try {
      const outcome = await action();
      if (outcome) setResult(outcome);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleGenerate(replace: boolean) {
    if (replace && !window.confirm("Replace the SSH key? The remote host must be given the new key before syncs work again.")) {
      return;
    }
    setResult(null);
    void runAction(() => generate.mutateAsync(replace));
  }

  async function copyLine(line: string) {
    await navigator.clipboard.writeText(line);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section class="rounded-lg border border-border bg-card/50 p-4" aria-labelledby="remote-agents-ssh-heading">
      <h3
        id="remote-agents-ssh-heading"
        class="mb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
      >
        SSH connection
      </h3>
      <Show
        when={sshQuery.data}
        fallback={
          <p class="text-sm text-muted-foreground">
            {sshQuery.isError ? "Failed to load SSH key state." : "Loading SSH key state..."}
          </p>
        }
      >
        {(ssh) => (
          <div class="space-y-3 text-sm">
            <Show
              when={ssh().authorizedKeysLine}
              fallback={
                <div class="flex flex-wrap items-center gap-3">
                  <p class="text-muted-foreground">Timeline has no SSH key for remote hosts yet.</p>
                  <button class={buttonClass} disabled={busy()} onClick={() => handleGenerate(false)}>
                    Generate key
                  </button>
                </div>
              }
            >
              {(line) => (
                <div class="space-y-2">
                  <p class="text-muted-foreground">
                    Add this line to <code class="px-1 rounded bg-muted">~/.ssh/authorized_keys</code> on the
                    remote host, and install <code class="px-1 rounded bg-muted">tools/timeline-export/timeline-export</code>{" "}
                    at <code class="px-1 rounded bg-muted">~/.local/bin/timeline-export</code>.
                  </p>
                  <div class="flex items-start gap-2">
                    <pre
                      class="flex-1 min-w-0 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs"
                      aria-label="authorized_keys line"
                    >
                      {line()}
                    </pre>
                    <button
                      class={buttonClass}
                      title="Copy authorized_keys line"
                      aria-label="Copy authorized_keys line"
                      onClick={() => void copyLine(line())}
                    >
                      <Show when={copied()} fallback={<IconCopy class="w-4 h-4" />}>Copied</Show>
                    </button>
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      class={buttonClass}
                      disabled={busy() || !ssh().host}
                      title={ssh().host ? undefined : "Save an SSH target first"}
                      onClick={() => void runAction(() => test.mutateAsync())}
                    >
                      <Show when={test.isPending} fallback="Test connection">
                        <span class="animate-pulse">Testing...</span>
                      </Show>
                    </button>
                    <button class={buttonClass} disabled={busy()} onClick={() => handleGenerate(true)}>
                      Replace key
                    </button>
                    <Show when={ssh().host}>
                      {(host) => (
                        <span class="text-muted-foreground">
                          {host().label}: {host().trusted ? "host key trusted" : "host key not trusted yet"}
                        </span>
                      )}
                    </Show>
                  </div>
                </div>
              )}
            </Show>

            <Show when={untrustedResult()}>
              {(untrusted) => (
                <div class="rounded-md border border-yellow-400/40 bg-yellow-400/10 p-3 space-y-2">
                  <Show
                    when={untrusted().changed}
                    fallback={
                      <p>
                        First connection to <span class="font-mono">{untrusted().host}</span>. Check that its host
                        key fingerprint matches before trusting it:
                      </p>
                    }
                  >
                    <p>
                      The host key for <span class="font-mono">{untrusted().host}</span> has changed since it was
                      trusted. Only trust the new fingerprint if you expected this, for example after reinstalling
                      the host:
                    </p>
                  </Show>
                  <p class="font-mono text-xs break-all">{untrusted().fingerprint}</p>
                  <button
                    class={buttonClass}
                    disabled={busy()}
                    onClick={() => void runAction(() => trust.mutateAsync(untrusted().fingerprint))}
                  >
                    {untrusted().changed ? "Trust new host key and test" : "Trust host and test"}
                  </button>
                </div>
              )}
            </Show>
            <Show when={okResult()}>
              {(ok) => (
                <div class="text-green-400" role="status">
                  Connected to <span class="font-mono">{ok().host}</span>
                  <ul class="mt-1 text-muted-foreground">
                    <For each={Object.entries(ok().targets)}>
                      {([name, target]) => (
                        <li>
                          <span class="font-mono">{name}</span>:{" "}
                          {target.available ? "available" : `missing${target.detail ? ` (${target.detail})` : ""}`}
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              )}
            </Show>
            <Show when={errorResult()}>
              {(failed) => <p class="text-red-400 break-words" role="alert">{failed().error}</p>}
            </Show>
            <Show when={actionError()}>
              {(error) => <p class="text-red-400" role="alert">{error()}</p>}
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}
