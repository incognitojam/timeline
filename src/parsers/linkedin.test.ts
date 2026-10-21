import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initDb } from "../db/schema";
import { importLinkedInData, toISO } from "./linkedin";

describe("linkedin toISO", () => {
  it("keeps a full UTC datetime as a full ISO timestamp", () => {
    expect(toISO("2025-12-15 20:39:35 UTC")).toBe("2025-12-15T20:39:35Z");
  });

  it("anchors the date-only 'connections' format to UTC midnight", () => {
    expect(toISO("13 Dec 2025")).toBe("2025-12-13T00:00:00Z");
  });

  it("anchors the month-only 'positions' format to the 1st at UTC midnight", () => {
    expect(toISO("Jan 2025")).toBe("2025-01-01T00:00:00Z");
  });

  it("produces timestamps the day-view range query includes", () => {
    // A bare 'YYYY-MM-DD' sorts before the day view's lower bound
    // ('DATE T00:00:00') and is hidden despite showing in search.
    const ts = toISO("13 Dec 2025");
    expect(ts && ts >= "2025-12-13T00:00:00" && ts < "2025-12-13T24:00:00").toBe(true);
  });

  it("returns null for an unrecognized format", () => {
    expect(toISO("")).toBeNull();
    expect(toISO("sometime last year")).toBeNull();
  });
});

describe("importLinkedInData conversation_id", () => {
  let db: Database;
  let importDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);
    importDir = join(tmpdir(), `linkedin-fixture-${randomUUID()}`);
    await mkdir(importDir, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(importDir, { recursive: true, force: true });
  });

  it("stores the CSV CONVERSATION ID on message rows, leaving non-messages null", async () => {
    await writeFile(
      join(importDir, "messages.csv"),
      [
        "CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT",
        "2-abc123==,,Alice Example,,Bob Example,,2025-12-15 20:39:35 UTC,,Hello there",
        "2-abc123==,,Bob Example,,Alice Example,,2025-12-16 09:00:00 UTC,,Hi back",
      ].join("\n"),
    );
    await writeFile(
      join(importDir, "Positions.csv"),
      ["Company Name,Title,Description,Location,Started On,Finished On", "Acme,Engineer,,,Jan 2025,"].join("\n"),
    );

    await importLinkedInData(db, importDir, "alice");

    const messages = db
      .prepare(
        "SELECT source_id, conversation_id FROM events WHERE source = 'linkedin' AND type = 'message' ORDER BY timestamp",
      )
      .all() as Array<{ source_id: string; conversation_id: string | null }>;
    // Both messages in the thread share the one CONVERSATION ID.
    expect(messages).toHaveLength(2);
    expect(messages[0].conversation_id).toBe("2-abc123==");
    expect(messages[1].conversation_id).toBe("2-abc123==");

    const position = db
      .prepare("SELECT conversation_id FROM events WHERE source = 'linkedin' AND type = 'job'")
      .get() as { conversation_id: string | null };
    expect(position.conversation_id).toBeNull();
  });
});
