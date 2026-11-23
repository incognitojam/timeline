/**
 * An AMR file's length, read from its frame headers without decoding audio.
 *
 * An AMR storage file (RFC 4867, section 5) is a magic line, then frames of
 * 20 ms each. A frame's first byte holds its frame type, and each type has a
 * fixed size, so walking the headers counts the frames.
 */

const FRAME_MS = 20;

interface Codec {
  name: "AMR-NB" | "AMR-WB";
  magic: string;
  /** Speech bytes after the header byte, by frame type; undefined for a reserved type. */
  sizes: readonly (number | undefined)[];
}

const reserved = (count: number): undefined[] => Array.from({ length: count }, () => undefined);

const CODECS: readonly Codec[] = [
  // Types 0–7 are speech modes, 8 is comfort noise, 9–14 reserved, 15 no data.
  { name: "AMR-NB", magic: "#!AMR\n", sizes: [12, 13, 15, 17, 19, 20, 26, 31, 5, ...reserved(6), 0] },
  // Types 0–8 are speech modes, 9 is comfort noise, 10–13 reserved, 14 speech lost, 15 no data.
  { name: "AMR-WB", magic: "#!AMR-WB\n", sizes: [17, 23, 32, 36, 40, 46, 50, 58, 60, 5, ...reserved(4), 0, 0] },
];

export interface AmrInfo {
  codec: Codec["name"];
  frames: number;
  durationMs: number;
}

/** The codec and length of an AMR file; throws on anything that is not a whole one. */
export function readAmr(bytes: Uint8Array): AmrInfo {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 9));
  const codec = CODECS.find((candidate) => head.startsWith(candidate.magic));
  if (!codec) throw new Error("not a single-channel AMR file");
  let at = codec.magic.length;
  let frames = 0;
  while (at < bytes.length) {
    const type = ((bytes[at] ?? 0) >> 3) & 0x0f;
    const size = codec.sizes[type];
    if (size === undefined) throw new Error(`reserved ${codec.name} frame type ${type} at byte ${at}`);
    at += 1 + size;
    if (at > bytes.length) throw new Error(`${codec.name} file ends part-way through a frame`);
    frames++;
  }
  if (frames === 0) throw new Error(`${codec.name} file has no frames`);
  return { codec: codec.name, frames, durationMs: frames * FRAME_MS };
}
