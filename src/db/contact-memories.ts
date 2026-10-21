import { Database } from "bun:sqlite";
import type { QueryExecutor } from "./pool";
import type { ContactMemory } from "./schema";

/**
 * Create a new memory for a contact
 */
export function createContactMemory(
  db: Database,
  contactId: number,
  content: string
): ContactMemory {
  const result = db
    .prepare(
      `INSERT INTO contact_memories (contact_id, content) VALUES (?, ?)`
    )
    .run(contactId, content);
  return {
    id: Number(result.lastInsertRowid),
    contact_id: contactId,
    content,
    created_at: new Date().toISOString(),
  };
}

/**
 * Delete a memory by ID, scoped to a specific contact
 */
export function deleteContactMemory(db: Database, contactId: number, memoryId: number): boolean {
  const result = db.prepare("DELETE FROM contact_memories WHERE id = ? AND contact_id = ?").run(memoryId, contactId);
  return result.changes > 0;
}

/**
 * Get all memories for a contact, newest first
 */
export async function getContactMemories(
  db: QueryExecutor,
  contactId: number
): Promise<ContactMemory[]> {
  return await db.query<ContactMemory>(
    "SELECT * FROM contact_memories WHERE contact_id = ? ORDER BY created_at DESC",
    contactId
  );
}
