import type {
  DiscordPollMedia,
  ParsedDiscordPoll,
  PollVoter,
} from "@shared/discord-forward";
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { getResolvedNameOr, resolveIdentifiers } from "../../lib/identities";
import Dialog from "../../ui/Dialog";
import { IconCheck } from "../../ui/icons";
import Avatar from "../Avatar";
import { DiscordEmoji } from "./DiscordEmoji";

// Discord avatar CDN hotlink, mirroring normalizeMessage in
// src/platforms/discord/client.ts. Undefined (no hash) lets Avatar fall back to
// its colored-initials placeholder.
function voterIdentifier(voter: PollVoter): string {
  return `discord:${voter.id}`;
}

function voterAvatarUrl(voter: PollVoter): string | undefined {
  return voter.avatar
    ? `https://cdn.discordapp.com/avatars/${voter.id}/${voter.avatar}.png`
    : undefined;
}

function PollMediaEmoji(props: { emoji: DiscordPollMedia["emoji"] }): JSX.Element {
  return (
    <Show when={props.emoji}>
      {(emoji) => (
        <Show
          when={emoji().id}
          fallback={<span class="text-lg leading-none">{emoji().name}</span>}
        >
          {(id) => <DiscordEmoji id={id()} name={emoji().name ?? ""} size="inline" />}
        </Show>
      )}
    </Show>
  );
}

// Vote counts come from results.answer_counts; when results are absent on a
// captured poll, the voter list length is the best available count.
function pollAnswerCount(parsedPoll: ParsedDiscordPoll, answerId: number): number {
  const { poll, votersByAnswerId } = parsedPoll;
  const answerCounts = poll.results?.answer_counts;
  const fromResults = answerCounts?.find((c) => c.id === answerId)?.count;
  return fromResults ?? votersByAnswerId.get(String(answerId))?.length ?? 0;
}

/**
 * Two-pane voter browser inside the dialog: answers on the left, the selected
 * answer's voter names on the right. Mounted fresh on each dialog open, so the
 * selection always resets to the first answer.
 */
function PollVotersDialogBody(props: { parsedPoll: ParsedDiscordPoll }): JSX.Element {
  const [selectedId, setSelectedId] = createSignal(props.parsedPoll.poll.answers[0]?.answer_id ?? 0);
  const selectedVoters = () => props.parsedPoll.votersByAnswerId.get(String(selectedId())) ?? [];

  // This body mounts fresh on each dialog open, so voters resolve when asked for.
  onMount(() => {
    void resolveIdentifiers(
      [...props.parsedPoll.votersByAnswerId.values()].flat().map(voterIdentifier),
    );
  });

  return (
    <div class="grid gap-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div class="flex min-w-0 flex-col gap-1 sm:max-h-[55vh] sm:overflow-y-auto">
        <For each={props.parsedPoll.poll.answers}>
          {(answer) => (
            <button
              type="button"
              aria-pressed={selectedId() === answer.answer_id}
              class={`flex items-center gap-2 rounded-sm border px-2.5 py-1.5 text-left ${
                selectedId() === answer.answer_id
                  ? "border-primary bg-primary/10 font-medium"
                  : "border-transparent enabled:hover:bg-accent"
              }`}
              onClick={() => setSelectedId(answer.answer_id)}
            >
              <PollMediaEmoji emoji={answer.poll_media.emoji} />
              <span class="min-w-0 flex-1 truncate">{answer.poll_media.text}</span>
              <span class="text-muted-foreground tabular-nums whitespace-nowrap">
                {pollAnswerCount(props.parsedPoll, answer.answer_id)}
              </span>
            </button>
          )}
        </For>
      </div>
      <div class="min-h-24 min-w-0 sm:max-h-[55vh] sm:overflow-y-auto sm:border-l sm:border-border/60 sm:pl-3">
        <Show
          when={selectedVoters().length > 0}
          fallback={<div class="text-muted-foreground px-1 py-1.5">No votes</div>}
        >
          <ul class="flex flex-col gap-0.5">
            <For each={selectedVoters()}>
              {(voter) => (
                <li class="flex items-center gap-2.5 rounded-sm px-1 py-1">
                  <Avatar
                    url={voterAvatarUrl(voter)}
                    name={getResolvedNameOr(voterIdentifier(voter), voter.name)}
                    size="sm"
                  />
                  <div class="min-w-0 flex-1 leading-tight">
                    <div class="truncate">{getResolvedNameOr(voterIdentifier(voter), voter.name)}</div>
                    <Show when={voter.username && voter.username !== voter.name}>
                      <div class="truncate text-xs text-muted-foreground">{voter.username}</div>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}

export function DiscordPoll(props: { parsedPoll: ParsedDiscordPoll }): JSX.Element {
  const poll = () => props.parsedPoll.poll;
  // Absent results means "not captured", not zero votes; within a present
  // results object, an answer missing from answer_counts genuinely has none.
  const hasResults = () => poll().results !== undefined;
  const counts = () => {
    const map = new Map<number, number>();
    for (const c of poll().results?.answer_counts ?? []) map.set(c.id, c.count);
    return map;
  };
  const myVotes = () => {
    const set = new Set<number>();
    for (const c of poll().results?.answer_counts ?? []) {
      if (c.me_voted) set.add(c.id);
    }
    return set;
  };
  const totalVotes = () => {
    let total = 0;
    for (const count of counts().values()) total += count;
    return total;
  };
  const closed = () => {
    if (poll().results?.is_finalized) return true;
    const expiry = poll().expiry;
    return expiry !== null && Date.parse(expiry) <= Date.now();
  };
  // Discord marks the top answer(s) with a check once the poll closes; a tie
  // marks every answer at the max.
  const winningCount = () => {
    if (!closed() || totalVotes() === 0) return null;
    return Math.max(...counts().values());
  };
  const percent = (count: number) =>
    totalVotes() > 0 ? Math.round((count / totalVotes()) * 100) : 0;
  const hasVoters = () => props.parsedPoll.hasVoterCapture;
  const [votersOpen, setVotersOpen] = createSignal(false);
  // A poll counts as counted with either results or captured voters; capture
  // runs on long-expired polls whose stored message may lack results, so fall
  // back to summing the per-answer voter lists (as pollAnswerCount does).
  const countedVotes = () => {
    if (hasResults()) return totalVotes();
    let total = 0;
    for (const answer of poll().answers) {
      total += props.parsedPoll.votersByAnswerId.get(String(answer.answer_id))?.length ?? 0;
    }
    return total;
  };
  const votesLabel = () =>
    hasResults() || hasVoters()
      ? `${countedVotes()} ${countedVotes() === 1 ? "vote" : "votes"}`
      : "Vote counts not captured";

  return (
    <div class="rounded-md border border-border/60 bg-muted/30 max-w-lg text-sm p-3 space-y-2">
      <div class="font-semibold leading-snug">{poll().question.text}</div>
      <Show when={poll().allow_multiselect}>
        <div class="text-sm text-muted-foreground -mt-1">Multiple answers allowed</div>
      </Show>
      <div class="space-y-1.5">
        <For each={poll().answers}>
          {(answer) => {
            const count = () => counts().get(answer.answer_id) ?? 0;
            const isWinner = () => winningCount() !== null && count() === winningCount();
            return (
              <div
                class={`relative rounded-md border overflow-hidden ${
                  isWinner() ? "border-green-600/60" : "border-border/50"
                }`}
              >
                <div
                  class={`absolute inset-y-0 left-0 ${
                    isWinner() ? "bg-green-500/15" : "bg-primary/10"
                  }`}
                  style={{ width: `${percent(count())}%` }}
                />
                <div class="relative flex items-center gap-2 px-3 py-1.5">
                  <PollMediaEmoji emoji={answer.poll_media.emoji} />
                  <span class="font-medium break-words">{answer.poll_media.text}</span>
                  <Show when={myVotes().has(answer.answer_id)}>
                    <span class="text-sm text-muted-foreground">· your vote</span>
                  </Show>
                  <Show when={hasResults()}>
                    <span class="ml-auto flex items-center gap-1.5 whitespace-nowrap pl-2">
                      <span class="text-muted-foreground">
                        {count()} {count() === 1 ? "vote" : "votes"}
                      </span>
                      <span class="font-semibold">{percent(count())}%</span>
                      <Show when={isWinner()}>
                        <span class="text-green-500" title="Winning answer">
                          <IconCheck class="h-4 w-4" aria-hidden />
                          <span class="sr-only">Winning answer</span>
                        </span>
                      </Show>
                    </span>
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
      </div>
      <div class="text-sm text-muted-foreground">
        <Show when={hasVoters()} fallback={votesLabel()}>
          <button
            type="button"
            class="underline decoration-dotted underline-offset-2 enabled:hover:text-foreground"
            onClick={() => setVotersOpen(true)}
          >
            {votesLabel()}
          </button>
        </Show>
        {" · "}
        {closed() ? "Poll closed" : "Poll open"}
      </div>
      <Show when={hasVoters()}>
        <Dialog
          open={votersOpen()}
          onClose={() => setVotersOpen(false)}
          title={poll().question.text}
          description={votesLabel()}
          class="max-w-[560px]"
        >
          <PollVotersDialogBody parsedPoll={props.parsedPoll} />
        </Dialog>
      </Show>
    </div>
  );
}
