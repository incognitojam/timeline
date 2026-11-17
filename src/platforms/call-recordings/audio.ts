/**
 * Serves a recording's audio from where call-transcribe keeps it. The path
 * always comes from the stored record, never from the request, and Timeline
 * never copies the file.
 */
import { isAbsolute } from "node:path";
import { playableAudio, readRecording } from "./shared/recording";

function json(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** A single `bytes=` range within `size`, null for none or several, "invalid" when it cannot be satisfied. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return header.includes(",") ? null : "invalid";
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return "invalid";
  if (from === "") {
    const suffix = Number(to);
    if (suffix === 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || end < start) return "invalid";
  return { start, end };
}

/** The response for `GET /api/call-recordings/:id/audio`, given the event's stored raw_data. */
export async function recordingAudioResponse(rawData: string, rangeHeader: string | undefined): Promise<Response> {
  const recording = readRecording(rawData);
  if (!recording) return json(500, "Stored recording record is unreadable");
  const audio = playableAudio(recording);
  if (!audio) return json(415, "No copy of this recording's audio is in a format browsers play");
  if (!isAbsolute(audio.path)) return json(500, "Stored audio path is not absolute");
  const file = Bun.file(audio.path);
  if (!(await file.exists())) return json(404, "Audio file not found");

  const size = file.size;
  const headers: Record<string, string> = {
    "Content-Type": audio.mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };
  const range = parseRange(rangeHeader, size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  if (range === null) return new Response(file, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
  return new Response(file.slice(range.start, range.end + 1), {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
    },
  });
}
