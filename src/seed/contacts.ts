import { createContact, updateContact } from "../db/contacts";
import { batchLinkIdentitiesToContact, parseIdentifier } from "../db/identities";
import type { SeedContext } from "./context";
import { EVERYONE } from "./persona";

/** Facts an assistant might have remembered about a contact. */
const MEMORIES: Partial<Record<string, readonly string[]>> = {
  rowan: ["Prefers early starts for hikes", "Allergic to peanuts"],
  mei: ["Moved to Portland in spring", "Training for a half marathon"],
  jordan: ["Owns the ingest pipeline on-call rota"],
};

/**
 * Create a contact for everyone in the persona (Alex as the self contact) and
 * link the platform identities the generators recorded via ctx.identify().
 * Every recorded identifier must exist: a mismatch means a generator and its
 * importer disagree about how the person is identified.
 */
export function seedContacts(ctx: SeedContext): void {
  const identified = ctx.identifiedPeople();
  const links: Array<{ platform: string; platformId: string; contactId: number }> = [];
  const memory = ctx.db.prepare("INSERT INTO contact_memories (contact_id, content) VALUES (?, ?)");

  for (const person of EVERYONE) {
    const identifiers = identified.get(person.key);
    if (!identifiers || identifiers.size === 0) continue;

    const contactId = createContact(ctx.db, person.name, person.notes);
    updateContact(ctx.db, contactId, {
      isSelf: person.relation === "self",
      dateOfBirth: person.dateOfBirth ?? null,
    });
    for (const fact of MEMORIES[person.key] ?? []) memory.run(contactId, fact);

    for (const identifier of identifiers) {
      const parsed = parseIdentifier(identifier);
      if (!parsed) throw new Error(`ctx.identify(${person.key}) got an unqualified identifier: ${identifier}`);
      links.push({ platform: parsed.platform, platformId: parsed.platformId, contactId });
    }
  }

  const { errors } = batchLinkIdentitiesToContact(ctx.db, links);
  if (errors.length > 0) {
    throw new Error(
      `Seed identities missing from the identities table (importer wrote a different identifier):\n` +
        errors.map((e) => `  ${e.identifier}: ${e.error}`).join("\n"),
    );
  }
}
