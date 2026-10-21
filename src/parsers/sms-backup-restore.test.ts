import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initDb } from "../db/schema";
import { importCalls, importMms, importSms } from "./sms-backup-restore";

interface EventRow {
  source_id: string;
  type: string;
  content: string;
  raw_data: string;
}

describe("sms-backup-restore", () => {
  let db: Database;
  let fixtureDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);

    fixtureDir = join(tmpdir(), `sms-fixture-${randomUUID()}`);
    await mkdir(fixtureDir, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  async function writeSmsXml(body: string): Promise<string> {
    const path = join(fixtureDir, `sms-${randomUUID()}.xml`);
    await writeFile(path, body);
    return path;
  }

  function getRows(): EventRow[] {
    return db
      .prepare(
        "SELECT source_id, type, content, raw_data FROM events WHERE source = 'phone' ORDER BY source_id"
      )
      .all() as EventRow[];
  }

  it("skips a message with an empty address instead of aborting the batch", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<smses count="2">
  <sms address="+447700900001" date="1700000000000" type="1" body="hello" contact_name="Alice" />
  <sms address="" date="1700000001000" type="1" body="ghost" contact_name="(Unknown)" />
</smses>`;
    const result = await importSms(db, await writeSmsXml(xml), "Owner", { silent: true });
    expect(result).toMatchObject({ imported: 1, unkeyed: 1 });
    expect(getRows().map((row) => row.content)).toEqual(["hello"]);
  });

  describe("conversation_id", () => {
    function getConversationIds(): string[] {
      return (
        db
          .prepare(
            "SELECT conversation_id FROM events WHERE source = 'phone' ORDER BY source_id",
          )
          .all() as { conversation_id: string | null }[]
      ).map((row) => row.conversation_id ?? "(null)");
    }

    it("keys sms on the normalized address, unifying national and international forms", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <sms protocol="0" address="07700900123" date="1747000000000" type="1" body="national" toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="0" sub_id="-1" readable_date="12 May 2026 00:00:00" contact_name="Alice" />
  <sms protocol="0" address="+447700900123" date="1747000001000" type="2" body="international" toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="0" sub_id="-1" readable_date="12 May 2026 00:00:01" contact_name="Alice" />
</smses>`;
      const path = await writeSmsXml(xml);
      await importSms(db, path, "tester", { silent: true });

      expect(getConversationIds()).toEqual(["+447700900123", "+447700900123"]);
    });

    it("keys group MMS on the sorted normalized participant list", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <mms address="+15550001111~07700900123" date="1747000005000" msg_box="1" _id="42" contact_name="Alice, Bob" read="1" sub_id="-1" m_type="132" read_status="null">
    <parts>
      <part seq="0" ct="text/plain" name="null" chset="106" cd="null" fn="null" cid="&lt;text_0&gt;" cl="text_0" ctt_s="null" ctt_t="null" text="group hi" />
    </parts>
    <addrs />
  </mms>
</smses>`;
      const path = await writeSmsXml(xml);
      await importMms(db, path, "tester", { silent: true });

      expect(getConversationIds()).toEqual(["+15550001111~+447700900123"]);
    });

    it("keys calls on the normalized number", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<calls>
  <call number="07700900123" duration="65" date="1747000006000" type="2" presentation="1" subscription_id="1" readable_date="12 May 2026 00:00:06" contact_name="Alice" />
</calls>`;
      const path = await writeSmsXml(xml);
      await importCalls(db, path, "tester", { silent: true });

      expect(getConversationIds()).toEqual(["+447700900123"]);
    });
  });

  describe("alphanumeric sender SMS", () => {
    it("stores sender ID in people identifier, not empty 'phone:'", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <sms protocol="0" address="ExampleSender" date="1747000000000" type="1" body="Example notification" toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="0" sub_id="-1" readable_date="12 May 2026 00:00:00" contact_name="(Unknown)" />
</smses>`;
      const path = await writeSmsXml(xml);
      await importSms(db, path, "Owner", { silent: true });

      const row = db
        .prepare(
          "SELECT people, source_id FROM events WHERE source = 'phone' ORDER BY id DESC LIMIT 1"
        )
        .get() as { people: string; source_id: string };

      expect(JSON.parse(row.people)).toEqual([
        "phone:ExampleSender",
        "phone:Owner",
      ]);
      expect(row.source_id).toBe("1747000000000-ExampleSender");
    });
  });

  describe("emoji entity decoding", () => {
    it("decodes a single supplementary-plane codepoint (smiley emoji)", async () => {
      // &#128578; is U+1F642 (slightly smiling face) — needs a surrogate pair.
      // The old String.fromCharCode-based decoder would mangle this into U+F642
      // (Private Use Area), which renders as tofu.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <sms protocol="0" address="+447700900123" date="1747000000000" type="1" body="Yes, it is &#128578;" toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="0" sub_id="-1" readable_date="12 May 2026 00:00:00" contact_name="Alice" />
</smses>`;
      const path = await writeSmsXml(xml);
      await importSms(db, path, "tester", { silent: true });

      const [row] = getRows();
      expect(row.content).toBe("Yes, it is 🙂");
    });

    it("decodes pair-of-codepoint emoji (flag = two regional indicators)", async () => {
      // &#127468;&#127463; is U+1F1EC U+1F1E7 — the GB flag, four UTF-16 code units total.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <sms protocol="0" address="+447700900124" date="1747000001000" type="2" body="From &#127468;&#127463;!" toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="0" sub_id="-1" readable_date="12 May 2026 00:00:01" contact_name="Bob" />
</smses>`;
      const path = await writeSmsXml(xml);
      await importSms(db, path, "tester", { silent: true });

      const [row] = getRows();
      expect(row.content).toBe("From 🇬🇧!");
    });

    it("still decodes BMP entities correctly (newlines, basic punctuation)", async () => {
      // &#10; (newline), &#33; (!), &amp; (literal &), &quot; (")
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <sms protocol="0" address="+447700900125" date="1747000002000" type="1" body="Line 1&#10;Line 2 &amp; &quot;quoted&quot;&#33;" toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="0" sub_id="-1" readable_date="12 May 2026 00:00:02" contact_name="Carol" />
</smses>`;
      const path = await writeSmsXml(xml);
      await importSms(db, path, "tester", { silent: true });

      const [row] = getRows();
      expect(row.content).toBe('Line 1\nLine 2 & "quoted"!');
    });

    it("leaves out-of-range numeric entities as literal text", async () => {
      // 0x110000 is one past the max valid Unicode codepoint; decoder must not crash.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <sms protocol="0" address="+447700900126" date="1747000003000" type="1" body="bad: &#1114112; ok" toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="0" sub_id="-1" readable_date="12 May 2026 00:00:03" contact_name="Dan" />
</smses>`;
      const path = await writeSmsXml(xml);
      await importSms(db, path, "tester", { silent: true });

      const [row] = getRows();
      expect(row.content).toBe("bad: &#1114112; ok");
    });

    it("decodes hex entities (&#xHHHH;)", async () => {
      // &#x1F600; = 😀
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <sms protocol="0" address="+447700900127" date="1747000004000" type="1" body="hex &#x1F600;" toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="0" sub_id="-1" readable_date="12 May 2026 00:00:04" contact_name="Eve" />
</smses>`;
      const path = await writeSmsXml(xml);
      await importSms(db, path, "tester", { silent: true });

      const [row] = getRows();
      expect(row.content).toBe("hex 😀");
    });

    it("decodes emoji inside MMS <part> text", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<smses>
  <mms address="+447700900128" date="1747000005000" msg_box="1" _id="42" contact_name="Frank" read="1" sub_id="-1" m_type="132" read_status="null">
    <parts>
      <part seq="0" ct="text/plain" name="null" chset="106" cd="null" fn="null" cid="&lt;text_0&gt;" cl="text_0" ctt_s="null" ctt_t="null" text="MMS hi &#127881;" />
    </parts>
    <addrs />
  </mms>
</smses>`;
      const path = await writeSmsXml(xml);
      await importMms(db, path, "tester", { silent: true });

      const [row] = getRows();
      expect(row.content).toBe("MMS hi 🎉");
    });
  });
});
