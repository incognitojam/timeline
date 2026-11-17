/**
 * Turns of a call-transcribe `.txt` transcript, stored as the event's content.
 * Two shapes exist:
 *
 *   Scribe (speakers named):           Parakeet (one voice, no speakers):
 *   # Call with: Alice (12 Nov 2026…)  [0:00:04] Hello?
 *                                      [0:00:09] Yes, it's me.
 *   13:11 <Alice> Hello?
 *   It's me.
 *
 *   13:12 <Alex> Hi.
 *
 * Scribe times are local wall-clock HH:MM; Parakeet times are offsets into
 * the recording. A Scribe turn runs one sentence per line until a blank line.
 */
export interface TranscriptTurn {
  /** As written: `HH:MM` for Scribe, `H:MM:SS` offset for Parakeet, null when absent. */
  time: string | null;
  speaker: string | null;
  text: string;
}

const SCRIBE_TURN = /^(\d{1,2}:\d{2}) <([^>]+)> ?(.*)$/;
const PARAKEET_LINE = /^\[(\d+:\d{2}:\d{2})\] ?(.*)$/;

export function parseTranscript(text: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let open: TranscriptTurn | null = null;
  const close = () => {
    if (open && open.text !== "") turns.push(open);
    open = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      close();
      continue;
    }
    if (line.startsWith("#") && open === null) continue;
    const scribe = SCRIBE_TURN.exec(line);
    if (scribe) {
      close();
      open = { time: scribe[1] ?? null, speaker: scribe[2]?.trim() ?? null, text: scribe[3]?.trim() ?? "" };
      continue;
    }
    const parakeet = PARAKEET_LINE.exec(line);
    if (parakeet) {
      close();
      turns.push({ time: parakeet[1] ?? null, speaker: null, text: parakeet[2]?.trim() ?? "" });
      continue;
    }
    if (open) {
      const current: TranscriptTurn = open;
      current.text = current.text === "" ? line : `${current.text} ${line}`;
    } else {
      open = { time: null, speaker: null, text: line };
    }
  }
  close();
  return turns;
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * When a turn was said, from the recording's `start` (ISO with the recorder's
 * offset): Scribe clock times are read in that offset, past midnight if they
 * wrap, and Parakeet offsets count from the start. Null when the turn has no time.
 */
export function turnInstant(turn: TranscriptTurn, start: string): number | null {
  const startMs = Date.parse(start);
  if (turn.time === null || Number.isNaN(startMs)) return null;
  const parts = turn.time.split(":").map(Number);
  if (parts.length === 3) {
    const [h = 0, m = 0, s = 0] = parts;
    return startMs + ((h * 60 + m) * 60 + s) * 1000;
  }
  const local = /T(\d{2}):(\d{2}):(\d{2})/.exec(start);
  if (!local) return null;
  const [h = 0, m = 0] = parts;
  const startMinute = Number(local[1]) * 60 + Number(local[2]);
  let delta = h * 60 + m - startMinute;
  if (delta < -MINUTES_PER_DAY / 2) delta += MINUTES_PER_DAY;
  return startMs - Number(local[3]) * 1000 + delta * 60_000;
}
