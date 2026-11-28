import { Database } from "../../../db/sqlite";
import { getTimelineDbPath, getAppStateDbPath } from "../../../db/paths";
import { previewActivityFile } from "../activity-import";

if (import.meta.main) {
  const [path, ...rest] = process.argv.slice(2);
  if (!path || rest.length)
    throw new Error("Usage: bun run src/platforms/jellyfin/scripts/preview-activity.ts <export.jsonl>");
  const timelinePath = getTimelineDbPath();
  using settings = new Database(getAppStateDbPath(timelinePath), { readonly: true });
  using db = new Database(timelinePath, { readwrite: true, create: false });
  db.exec("PRAGMA busy_timeout = 30000; PRAGMA recursive_triggers = ON");
  console.log(JSON.stringify(await previewActivityFile(db, path, settings), null, 2));
}
