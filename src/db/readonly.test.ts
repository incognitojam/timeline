import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReadOnlySql } from "./queries";
import { wrapDatabase } from "./pool";
import { openReadonlyDbAtPath } from "./readonly";

describe("readonly database", () => {
  test("openReadonlyDbAtPath rejects write operations at SQLite level", () => {
    // Create a temp database and open it readonly
    const tempPath = `/tmp/timeline-test-${Date.now()}.db`;
    const writeDb = new Database(tempPath);
    writeDb.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    writeDb.exec("INSERT INTO test (value) VALUES ('initial')");
    writeDb.close();

    // Open readonly
    const readonlyDb = openReadonlyDbAtPath(tempPath);

    // Verify we can read
    const rows = readonlyDb.prepare("SELECT * FROM test").all();
    expect(rows).toHaveLength(1);

    // Verify writes are rejected by SQLite
    expect(() => {
      readonlyDb.exec("INSERT INTO test (value) VALUES ('should fail')");
    }).toThrow(/readonly/i);

    expect(() => {
      readonlyDb.exec("UPDATE test SET value = 'should fail'");
    }).toThrow(/readonly/i);

    expect(() => {
      readonlyDb.exec("DELETE FROM test");
    }).toThrow(/readonly/i);

    expect(() => {
      readonlyDb.exec("DROP TABLE test");
    }).toThrow(/readonly/i);

    readonlyDb.close();

    // Cleanup
    unlinkSync(tempPath);
  });

  test("openReadonlyDbAtPath rejects .no-local-db marker", () => {
    const tempDir = join(tmpdir(), `timeline-readonly-marker-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, ".no-local-db"), "");
    const dbPath = join(tempDir, "timeline.db");

    expect(() => openReadonlyDbAtPath(dbPath)).toThrow(/Refusing to use database/);

    rmSync(tempDir, { recursive: true });
  });

  test("runReadOnlySql rejects non-SELECT queries", async () => {
    const tempPath = `/tmp/timeline-test-${Date.now()}.db`;
    const db = new Database(tempPath);
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    const qe = wrapDatabase(db);

    // Should reject INSERT
    let result = await runReadOnlySql(qe, "INSERT INTO test (value) VALUES ('bad')");
    expect(result.error).toBe("Only SELECT queries are allowed");
    expect(result.rows).toHaveLength(0);

    // Should reject UPDATE
    result = await runReadOnlySql(qe, "UPDATE test SET value = 'bad'");
    expect(result.error).toBe("Only SELECT queries are allowed");

    // Should reject DELETE
    result = await runReadOnlySql(qe, "DELETE FROM test");
    expect(result.error).toBe("Only SELECT queries are allowed");

    // Should reject DROP
    result = await runReadOnlySql(qe, "DROP TABLE test");
    expect(result.error).toBe("Only SELECT queries are allowed");

    // Should reject queries with dangerous keywords even in subqueries
    result = await runReadOnlySql(qe, "SELECT * FROM test; DELETE FROM test");
    expect(result.error).toContain("disallowed keyword: delete");

    db.close();
    unlinkSync(tempPath);
  });

  test("runReadOnlySql allows valid SELECT queries", async () => {
    const tempPath = `/tmp/timeline-test-${Date.now()}.db`;
    const db = new Database(tempPath);
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO test (value) VALUES ('one'), ('two'), ('three')");
    const qe = wrapDatabase(db);

    // Basic SELECT
    let result = await runReadOnlySql(qe, "SELECT * FROM test");
    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(3);
    expect(result.count).toBe(3);

    // WITH (CTE) query
    result = await runReadOnlySql(qe, "WITH cte AS (SELECT * FROM test) SELECT * FROM cte");
    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(3);

    // Respects maxRows limit
    result = await runReadOnlySql(qe, "SELECT * FROM test", 2);
    expect(result.rows).toHaveLength(2);
    expect(result.count).toBe(3); // Total count still reported

    db.close();
    unlinkSync(tempPath);
  });

  test("runReadOnlySql handles SQL errors gracefully", async () => {
    const tempPath = `/tmp/timeline-test-${Date.now()}.db`;
    const db = new Database(tempPath);
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
    const qe = wrapDatabase(db);

    // Invalid SQL
    const result = await runReadOnlySql(qe, "SELECT * FROM nonexistent_table");
    expect(result.error).toContain("no such table");
    expect(result.rows).toHaveLength(0);

    db.close();
    unlinkSync(tempPath);
  });
});
