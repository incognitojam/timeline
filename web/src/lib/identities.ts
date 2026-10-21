/**
 * Identity resolution service with Query-backed reactive caching.
 *
 * Resolves platform identifiers (e.g., "discord:123456789") to display names
 * and contact IDs, cached in the app QueryClient.
 *
 * Solid Query's reactivity lives in observers (createQuery); the QueryCache
 * itself is a plain framework-agnostic store, and getQueryData is an untracked
 * lookup. Observers won't work here: the read helpers are synchronous per-
 * identifier calls made mid-render for hundreds of ids, and resolution is
 * batched over one POST rather than per-key queryFns. So a single cache
 * subscription bumps a version signal; readers touch it before snapshotting,
 * which keeps them reactive inside Solid tracking scopes.
 */

import { createSignal } from "solid-js";
import type { EventParticipant } from "@shared/types";
import { buildContactsUrl } from "./routes";
import { resolveContact } from "./api";
import { queryClient } from "./query-client";

const API_BASE = typeof window !== "undefined" ? "" : "http://localhost:3001";

export interface ResolvedIdentity {
  name: string | null;
  username: string | null;
  contactId: number | null;
  avatarUrl: string | null;
  isSelf: boolean;
}

const IDENTITY_QUERY_ROOT = "identity";

const unresolvedIdentity: ResolvedIdentity = {
  name: null,
  username: null,
  contactId: null,
  avatarUrl: null,
  isSelf: false,
};

function identityQueryKey(identifier: string) {
  return [IDENTITY_QUERY_ROOT, identifier] as const;
}

// Identity reads are observer-less cache snapshots, so any finite gcTime can
// evict entries while they are still rendered without a fetch or observer event
// to restore them. Entries are small and session-scoped; link/unlink removal
// invalidates stale entries, and the persistence allowlist excludes them.
queryClient.setQueryDefaults([IDENTITY_QUERY_ROOT], {
  gcTime: Infinity,
});

const [identityCacheVersion, setIdentityCacheVersion] = createSignal(0);

queryClient.getQueryCache().subscribe((event) => {
  if (
    event.query.queryKey[0] === IDENTITY_QUERY_ROOT &&
    (event.type === "added" ||
      event.type === "removed" ||
      (event.type === "updated" &&
        (event.action.type === "success" || event.action.type === "setState")))
  ) {
    setIdentityCacheVersion((version) => version + 1);
  }
});

function getCachedIdentity(identifier: string): ResolvedIdentity | undefined {
  identityCacheVersion();
  return queryClient.getQueryData<ResolvedIdentity>(identityQueryKey(identifier));
}

function setCachedIdentity(identifier: string, identity: ResolvedIdentity): void {
  queryClient.setQueryData(identityQueryKey(identifier), identity);
}

interface IdentityWaiter {
  promise: Promise<void>;
  resolve: () => void;
}

interface ResolutionBatch {
  identifiers: string[];
}

// Pending resolution requests are kept separate from the Query cache. A
// waiter belongs to an identifier, not whichever batch happened to be active
// when it was requested, so it cannot return before its own identifier's batch.
let pendingIdentifiers = new Set<string>();
let pendingIdentityWaiters = new Map<string, IdentityWaiter>();
let pendingResolvePromise: Promise<ResolutionBatch> | null = null;

function waitForIdentity(identifier: string): Promise<void> {
  const existing = pendingIdentityWaiters.get(identifier);
  if (existing) return existing.promise;

  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (!resolve) throw new Error("Failed to create identity resolution waiter");

  pendingIdentityWaiters.set(identifier, { promise, resolve });
  pendingIdentifiers.add(identifier);
  return promise;
}

async function resolveBatch(identifiers: string[]): Promise<ResolutionBatch> {
  try {
    const res = await fetch(`${API_BASE}/api/identities/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers }),
      credentials: "include",
    });

    if (!res.ok) {
      console.error("Failed to resolve identities:", res.status);
      return { identifiers };
    }

    const data = await res.json() as { resolved: Record<string, ResolvedIdentity> };

    for (const identifier of identifiers) {
      setCachedIdentity(identifier, data.resolved[identifier] ?? unresolvedIdentity);
    }

    return { identifiers };
  } catch (err) {
    console.error("Error resolving identities:", err);
    return { identifiers };
  }
}

function resolveIdentityWaiter(identifier: string): void {
  const waiter = pendingIdentityWaiters.get(identifier);
  waiter?.resolve();
  pendingIdentityWaiters.delete(identifier);
}

function startPendingResolution(): void {
  if (pendingResolvePromise || pendingIdentifiers.size === 0) return;

  const queuedIdentifiers = Array.from(pendingIdentifiers);
  pendingIdentifiers = new Set();
  const identifiers: string[] = [];
  for (const identifier of queuedIdentifiers) {
    if (getCachedIdentity(identifier) === undefined) {
      identifiers.push(identifier);
    } else {
      resolveIdentityWaiter(identifier);
    }
  }
  if (identifiers.length === 0) return;

  const batchPromise = resolveBatch(identifiers);
  pendingResolvePromise = batchPromise;

  void batchPromise
    .then((batch) => {
      for (const identifier of batch.identifiers) {
        resolveIdentityWaiter(identifier);
      }
    })
    .finally(() => {
      pendingResolvePromise = null;
      startPendingResolution();
    });
}

/**
 * Parse a platform identifier into platform and platformId.
 * Format: "platform:platformId" (e.g., "discord:123456789", "name:Alice Example")
 */
export function parseIdentifier(identifier: string): { platform: string; platformId: string } | null {
  const colonIndex = identifier.indexOf(":");
  if (colonIndex === -1) return null;
  return {
    platform: identifier.slice(0, colonIndex),
    platformId: identifier.slice(colonIndex + 1),
  };
}

export function formatIdentifier(platform: string, platformId: string): string {
  return `${platform}:${platformId}`;
}

export function isQualifiedIdentifier(identifier: string): boolean {
  const parsed = parseIdentifier(identifier);
  if (!parsed) return false;
  if (!parsed.platform || /\s/.test(parsed.platform)) return false;
  if (parsed.platform === "name") return false;
  if (!parsed.platformId || !parsed.platformId.trim()) return false;
  return true;
}

/**
 * Get display name from an identifier.
 * Returns the resolved name if cached, otherwise returns a fallback.
 */
export function getDisplayName(identifier: string): string {
  const cached = getCachedIdentity(identifier);
  if (cached?.name) return cached.name;

  // Fallback: extract a readable name from the identifier
  const parsed = parseIdentifier(identifier);
  if (!parsed) return identifier;

  // For "name:" identifiers, the platformId is the name
  if (parsed.platform === "name") {
    return parsed.platformId;
  }

  // For platformIds like "name:Alice Example", strip the prefix
  if (parsed.platformId.startsWith("name:")) {
    return parsed.platformId.slice("name:".length);
  }

  // For other platforms, show username if available, otherwise the ID
  if (cached?.username) return cached.username;

  return parsed.platformId;
}

/**
 * Get the contact ID for an identifier, if linked.
 */
export function getContactId(identifier: string): number | null {
  return getCachedIdentity(identifier)?.contactId ?? null;
}

/**
 * Get avatar URL for an identifier.
 */
export function getAvatarUrl(identifier: string): string | null {
  return getCachedIdentity(identifier)?.avatarUrl ?? null;
}

/**
 * Check if an identifier has been resolved (exists in cache).
 */
export function isResolved(identifier: string): boolean {
  return getCachedIdentity(identifier) !== undefined;
}

/**
 * Get the full resolved identity for an identifier.
 */
export function getResolvedIdentity(identifier: string): ResolvedIdentity | null {
  return getCachedIdentity(identifier) ?? null;
}

/**
 * Name a reaction actor or poll voter by their contact. The cache is populated
 * from a conversation's senders, so these need resolving before they hit.
 */
export function getResolvedNameOr(identifier: string | null, capturedName: string): string {
  return (identifier ? getCachedIdentity(identifier)?.name : null) ?? capturedName;
}

/**
 * Batch resolve identifiers that aren't in the cache.
 * Deduplicates concurrent requests.
 */
export async function resolveIdentifiers(identifiers: string[]): Promise<void> {
  const waiters = Array.from(new Set(identifiers))
    .filter((identifier) => getCachedIdentity(identifier) === undefined)
    .map(waitForIdentity);
  if (waiters.length === 0) return;

  startPendingResolution();
  await Promise.all(waiters);
}

/**
 * Pre-populate the cache with identity data (e.g., from API response).
 * Useful when the API returns participants alongside events.
 */
export function populateCache(identities: Record<string, ResolvedIdentity>): void {
  for (const [id, resolved] of Object.entries(identities)) {
    setCachedIdentity(id, resolved);
  }
}

/**
 * Seed the identity cache from a conversation page's participant map, as
 * returned alongside events by the conversation endpoints. Participants
 * don't carry a username, so it's left null.
 */
export function populateCacheFromParticipants(
  participants: Record<string, EventParticipant> | undefined,
): void {
  if (!participants) return;
  const identities: Record<string, ResolvedIdentity> = {};
  for (const [id, p] of Object.entries(participants)) {
    identities[id] = {
      name: p.name,
      username: null,
      contactId: p.contactId,
      avatarUrl: p.avatarUrl ?? null,
      isSelf: p.isSelf,
    };
  }
  populateCache(identities);
}

/**
 * Clear the identity cache (useful for testing or manual refresh).
 */
export function clearCache(): void {
  queryClient.removeQueries({ queryKey: [IDENTITY_QUERY_ROOT] });
}

/**
 * Invalidate specific identifiers from the cache.
 */
export function invalidateCache(identifiers: string[]): void {
  for (const id of identifiers) {
    queryClient.removeQueries({ queryKey: identityQueryKey(id), exact: true });
  }
}

/**
 * Extract all unique identifiers from an array of events.
 */
export function extractIdentifiers(events: Array<{ people: string | null }>): string[] {
  const identifiers = new Set<string>();

  for (const event of events) {
    if (!event.people) continue;
    try {
      const people = JSON.parse(event.people) as string[];
      for (const person of people) {
        if (person && person.includes(":")) {
          identifiers.add(person);
        }
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return Array.from(identifiers);
}

/**
 * Resolve all identifiers from events and return when complete.
 * This is the main entry point for components loading events.
 */
export async function resolveEventsIdentities(events: Array<{ people: string | null }>): Promise<void> {
  const identifiers = extractIdentifiers(events);
  if (identifiers.length > 0) {
    await resolveIdentifiers(identifiers);
  }
}

/**
 * Get sender display name from an event's people field.
 * The sender is always the first person in the array.
 */
export function getSenderFromEvent(event: { people: string | null }): string | null {
  if (!event.people) return null;
  try {
    const people = JSON.parse(event.people) as string[];
    const sender = people[0];
    if (!sender) return null;
    return getDisplayName(sender);
  } catch {
    return null;
  }
}

/**
 * Whether an identifier resolves to the contact marked as the user (`is_self`).
 */
export function isSelfIdentifier(identifier: string): boolean {
  return getCachedIdentity(identifier)?.isSelf ?? false;
}

/**
 * Get the sender identifier (not display name) from an event.
 */
export function getSenderIdentifier(event: { people: string | null }): string | null {
  if (!event.people) return null;
  try {
    const people = JSON.parse(event.people) as string[];
    return people[0] || null;
  } catch {
    return null;
  }
}

// Conversation-shaped types, where the sender says which side of the exchange
// an event came from: "message", "message:dm", "instagram:message:dm",
// "sms:sent", "mms:received".
const MESSAGE_TYPE_PATTERN = /(^|:)(message|sms|mms)(:|$)/;

/**
 * Label for an event's sender line, or null when the sender shouldn't be shown.
 *
 * The user is named only on conversation-shaped events, where the sender says
 * who spoke; everything else on the timeline is the user's own activity, so
 * repeating their name adds nothing.
 */
export function getSenderLabel(event: { people: string | null; type: string }): string | null {
  const identifier = getSenderIdentifier(event);
  if (!identifier) return null;
  if (isSelfIdentifier(identifier)) {
    return MESSAGE_TYPE_PATTERN.test(event.type) ? "You" : null;
  }
  return getDisplayName(identifier);
}

/**
 * Get all people display names from an event.
 */
export function getPeopleFromEvent(event: { people: string | null }): string[] {
  if (!event.people) return [];
  try {
    const people = JSON.parse(event.people) as string[];
    return people.map(p => getDisplayName(p)).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolve an identifier and navigate to its contact or unlinked identity page.
 * Checks identity cache first, falls back to API resolution.
 */
export async function navigateToIdentity(
  navigate: (url: string) => void,
  identifier: string,
  source?: string,
) {
  // Fast path: check identity cache
  const contactId = getContactId(identifier);
  if (contactId) {
    navigate(buildContactsUrl({ id: contactId }));
    return;
  }

  // Resolve via API
  const parsed = parseIdentifier(identifier);
  const platform = source || parsed?.platform;
  const contact = await resolveContact(identifier, platform);
  if (contact) {
    navigate(buildContactsUrl({ id: contact.id }));
  } else {
    navigate(buildContactsUrl({ unlinked: identifier, source: platform || "", view: "unlinked" }));
  }
}
