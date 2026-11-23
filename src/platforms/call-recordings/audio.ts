/**
 * Serves a recording's playable copy from Timeline's media store, with byte
 * ranges so every browser can seek it. The copy is the event's attachment;
 * the AMR original is never served, since browsers can't play it.
 */
import type { QueryExecutor } from "../../db/pool";
import { getMediaStore, readOrRestore } from "../../media/storage";
import { EVENT_SOURCE } from "./parser";

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

/** The response for `GET /api/call-recordings/:id/audio`. */
export async function recordingAudioResponse(db: QueryExecutor, eventId: number, rangeHeader: string | undefined): Promise<Response> {
  const event = await db.get<{ id: number }>("SELECT id FROM events WHERE id = ? AND source = ?", eventId, EVENT_SOURCE);
  if (!event) return json(404, "Recording not found");
  const copy = await db.get<{ storage_path: string; content_hash: string; mime_type: string }>(
    `SELECT storage_path, content_hash, mime_type FROM attachments
     WHERE event_id = ? AND status = 'stored' AND mime_type NOT LIKE 'audio/amr%'
     ORDER BY id LIMIT 1`,
    eventId,
  );
  if (!copy) return json(415, "This recording has no copy browsers play");
  const file = await readOrRestore(await getMediaStore(), copy.storage_path, () => copy.content_hash);
  if (!file) return json(404, "Audio file not found");

  const size = file.fileSize;
  const headers: Record<string, string> = {
    "Content-Type": copy.mime_type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };
  const range = parseRange(rangeHeader, size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  if (range === null) return new Response(file.content, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
  return new Response(file.content.slice(range.start, range.end + 1), {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
    },
  });
}
