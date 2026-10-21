import { sourceLabel } from "@shared/sources";

/**
 * Rich query parser for timeline search
 *
 * Supported syntax:
 *   source:discord,spotify   - filter by source(s)
 *   type:message             - filter by type (prefix match)
 *   date:2024-01-15          - specific date
 *   date:2024-01             - specific month
 *   date:2024                - specific year
 *   after:2024-01-01         - start date
 *   before:2024-12-31        - end date
 *   from:username            - legacy sender-like text search
 *   at:location              - location name search
 *   contact:42               - events involving contact ID
 *   chat:name                - filter by conversation/chat title
 *   sort:asc|desc            - sort order (asc/oldest = oldest first, desc/newest = newest first)
 *   <text>                   - full-text search
 */

export interface ParsedQuery {
  text: string;           // Remaining FTS query
  source?: string;        // Source filter (comma-separated for multiple)
  type?: string;          // Type filter (prefix match)
  startDate?: string;     // After date
  endDate?: string;       // Before date
  date?: string;          // Original date: value (for display)
  from?: string;          // Legacy sender-like text search
  location?: string;      // Location filter
  contact?: string;       // Contact ID filter
  chat?: string;          // Chat/conversation title filter
  sort?: 'asc' | 'desc';  // Sort order (asc = oldest first, desc = newest first)
}

export interface FilterToken {
  key: string;
  value: string;
  start: number;  // Position in original string
  end: number;
}

export interface ContactAutocompleteOption {
  id: number;
  displayName: string;
  eventCount: number;
  avatarUrl: string | null;
}

export const INVALID_CONTACT_FILTER_MESSAGE = "Select a contact from the suggestions.";

export function parseContactFilterId(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const contactId = Number(value);
  return Number.isSafeInteger(contactId) ? contactId : undefined;
}

// Filter keywords and their descriptions
export const FILTER_KEYWORDS = [
  { key: 'source:', description: 'Filter by data source', examples: ['discord', 'spotify', 'youtube'] },
  { key: 'type:', description: 'Filter by event type', examples: ['message', 'listen', 'browse'] },
  { key: 'date:', description: 'Events on specific date', examples: ['2024-01-15', '2024-01', '2024'] },
  { key: 'after:', description: 'Events after date', examples: ['2024-01-01'] },
  { key: 'before:', description: 'Events before date', examples: ['2024-12-31'] },
  { key: 'at:', description: 'Events at location', examples: ['coffee', 'london'] },
  { key: 'contact:', description: 'Events involving contact', examples: ['42'] },
  { key: 'chat:', description: 'Filter by chat/conversation', examples: ['bob', 'team'] },
  { key: 'sort:', description: 'Sort order', examples: ['asc', 'desc', 'oldest', 'newest'] },
] as const;

// Regex to match filter:value tokens (handles quoted values too)
const FILTER_REGEX = /\b(source|type|date|after|before|from|at|contact|chat|sort):("([^"]+)"|(\S+))/gi;

/**
 * Parse a query string into structured filters + remaining text
 */
export function parseQuery(query: string): ParsedQuery {
  const result: ParsedQuery = { text: '' };
  const tokens: FilterToken[] = [];

  // Find all filter:value pairs
  let match;
  while ((match = FILTER_REGEX.exec(query)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[3] || match[4]; // Quoted or unquoted value
    tokens.push({
      key,
      value,
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  // Collect multiple sources/types
  const sources: string[] = [];
  const types: string[] = [];

  // Process tokens
  for (const token of tokens) {
    switch (token.key) {
      case 'source':
        sources.push(token.value);
        break;
      case 'type':
        types.push(token.value);
        break;
      case 'date':
        // Parse date:YYYY-MM-DD, date:YYYY-MM, or date:YYYY
        const dateVal = token.value;
        result.date = dateVal;  // Store original for display
        if (dateVal.length === 4) {
          // Year only: 2024 -> 2024-01-01 to 2024-12-31
          result.startDate = `${dateVal}-01-01`;
          result.endDate = `${dateVal}-12-31`;
        } else if (dateVal.length === 7) {
          // Year-month: 2024-01 -> 2024-01-01 to 2024-01-31
          result.startDate = `${dateVal}-01`;
          // Calculate last day of month
          const [year, month] = dateVal.split('-').map(Number);
          const lastDay = new Date(year, month, 0).getDate();
          result.endDate = `${dateVal}-${lastDay.toString().padStart(2, '0')}`;
        } else {
          // Full date: 2024-01-15
          result.startDate = dateVal;
          result.endDate = dateVal;
        }
        break;
      case 'after':
        result.startDate = token.value;
        break;
      case 'before':
        result.endDate = token.value;
        break;
      case 'from':
        result.from = token.value;
        break;
      case 'at':
        result.location = token.value;
        break;
      case 'contact':
        result.contact = token.value;
        break;
      case 'chat':
        result.chat = token.value;
        break;
      case 'sort':
        // Normalize sort values: asc/oldest -> asc, desc/newest -> desc
        const sortVal = token.value.toLowerCase();
        if (sortVal === 'asc' || sortVal === 'oldest') {
          result.sort = 'asc';
        } else if (sortVal === 'desc' || sortVal === 'newest') {
          result.sort = 'desc';
        }
        break;
    }
  }

  // Preserve an empty contact value so callers can reject it instead of
  // treating `contact:` as an empty query and loading recent events.
  if (/\bcontact:(?=\s|$)/i.test(query)) {
    result.contact = '';
  }

  // Join multiple sources/types with commas
  if (sources.length > 0) {
    result.source = sources.join(',');
  }
  if (types.length > 0) {
    result.type = types.join(',');
  }

  // Remove filter tokens from query to get remaining text
  let remaining = query;
  // Sort tokens by start position descending to remove from end first
  tokens.sort((a, b) => b.start - a.start);
  for (const token of tokens) {
    remaining = remaining.slice(0, token.start) + remaining.slice(token.end);
  }
  
  // Also remove incomplete filter prefixes like "source:" or "type:" that would break FTS5
  // These look like column:term syntax to FTS5 and cause errors
  remaining = remaining.replace(/\b(source|type|date|after|before|from|at|contact|chat|sort):\s*/gi, '');
  
  result.text = remaining.trim().replace(/\s+/g, ' ');

  return result;
}

/** Find the filter fragment that autocomplete should replace. */
function getActiveAutocompleteToken(
  beforeCursor: string,
  availableSources: string[],
): { value: string; replaceFrom: number } {
  const wordMatch = beforeCursor.match(/(\S+)$/);
  const word = wordMatch ? wordMatch[1] : '';
  const fallback = { value: word, replaceFrom: beforeCursor.length - word.length };
  if (word.includes(':')) return fallback;

  const sourceMatches = [...beforeCursor.matchAll(/\bsource:/gi)];
  const lastSourceMatch = sourceMatches[sourceMatches.length - 1];
  if (lastSourceMatch?.index === undefined) return fallback;

  const sourceFilter = beforeCursor.slice(lastSourceMatch.index);
  const partialSource = sourceFilter.slice('source:'.length).toLowerCase();
  const matchesSource = availableSources.some((source) =>
    source.toLowerCase().startsWith(partialSource) ||
    sourceLabel(source).toLowerCase().startsWith(partialSource)
  );

  return matchesSource
    ? { value: sourceFilter, replaceFrom: lastSourceMatch.index }
    : fallback;
}

/** Get autocomplete suggestions based on current input. */
export function getAutocompleteSuggestions(
  query: string,
  cursorPosition: number,
  availableSources: string[],
  availableTypes: string[],
  availableContacts: ContactAutocompleteOption[] = [],
): AutocompleteSuggestion[] {
  const suggestions: AutocompleteSuggestion[] = [];

  // Find what the user is currently typing (word at cursor). Source display
  // labels may contain spaces, so retain the whole source filter while its
  // value remains a prefix of a known ID or label.
  const beforeCursor = query.slice(0, cursorPosition);
  const { value: currentWord, replaceFrom } = getActiveAutocompleteToken(
    beforeCursor,
    availableSources,
  );

  if (!currentWord) {
    // Show all filter keywords when starting fresh or after space
    return FILTER_KEYWORDS.map(f => ({
      type: 'keyword' as const,
      value: f.key,
      description: f.description,
      insertText: f.key,
    }));
  }

  // Check if we're typing a filter keyword
  const colonIndex = currentWord.indexOf(':');
  
  if (colonIndex === -1) {
    // No colon yet - suggest matching filter keywords
    const matchingKeywords = FILTER_KEYWORDS.filter(f => 
      f.key.startsWith(currentWord.toLowerCase())
    );
    
    for (const kw of matchingKeywords) {
      suggestions.push({
        type: 'keyword',
        value: kw.key,
        description: kw.description,
        insertText: kw.key,
        replaceFrom,
      });
    }
  } else {
    // After colon - suggest values for this filter
    const filterKey = currentWord.slice(0, colonIndex).toLowerCase();
    const partialValue = currentWord.slice(colonIndex + 1).toLowerCase();

    if (filterKey === 'source') {
      const matchingSources = availableSources.filter(s =>
        s.toLowerCase().startsWith(partialValue) ||
        sourceLabel(s).toLowerCase().startsWith(partialValue)
      );
      for (const source of matchingSources) {
        suggestions.push({
          type: 'value',
          value: `source:${source}`,
          description: `Source: ${sourceLabel(source)}`,
          insertText: `source:${source}`,
          replaceFrom,
        });
      }
    } else if (filterKey === 'type') {
      const matchingTypes = availableTypes.filter(t => 
        t.toLowerCase().startsWith(partialValue)
      );
      for (const type of matchingTypes) {
        suggestions.push({
          type: 'value',
          value: `type:${type}`,
          description: `Type: ${type}`,
          insertText: `type:${type}`,
          replaceFrom,
        });
      }
    } else if (filterKey === 'contact') {
      const matchingContacts = availableContacts
        .filter((contact) =>
          contact.displayName.toLowerCase().includes(partialValue) ||
          String(contact.id).startsWith(partialValue)
        )
        .sort((a, b) => {
          const aName = a.displayName.toLowerCase();
          const bName = b.displayName.toLowerCase();
          const aRank = aName === partialValue ? 0 : aName.startsWith(partialValue) ? 1 : 2;
          const bRank = bName === partialValue ? 0 : bName.startsWith(partialValue) ? 1 : 2;
          return aRank - bRank || aName.localeCompare(bName);
        })
        .slice(0, 20);
      for (const contact of matchingContacts) {
        suggestions.push({
          type: 'value',
          value: contact.displayName,
          description: `${contact.eventCount} event${contact.eventCount === 1 ? '' : 's'}`,
          insertText: `contact:${contact.id}`,
          replaceFrom,
          contact,
        });
      }
    } else if (filterKey === 'date' || filterKey === 'after' || filterKey === 'before') {
      // Only show date suggestions if user hasn't started typing a date yet
      if (partialValue === '') {
        const today = new Date();
        const year = today.getFullYear();
        const month = (today.getMonth() + 1).toString().padStart(2, '0');
        const day = today.getDate().toString().padStart(2, '0');

        suggestions.push(
          {
            type: 'value',
            value: `${filterKey}:${year}-${month}-${day}`,
            description: 'Today',
            insertText: `${filterKey}:${year}-${month}-${day}`,
            replaceFrom,
          },
          {
            type: 'value',
            value: `${filterKey}:${year}-${month}`,
            description: 'This month',
            insertText: `${filterKey}:${year}-${month}`,
            replaceFrom,
          },
          {
            type: 'value',
            value: `${filterKey}:${year}`,
            description: 'This year',
            insertText: `${filterKey}:${year}`,
            replaceFrom,
          }
        );
      }
      // If user is typing their own date, don't suggest anything - let them type
    } else if (filterKey === 'sort') {
      const sortOptions = [
        { value: 'desc', description: 'Newest first (default)' },
        { value: 'asc', description: 'Oldest first' },
        { value: 'newest', description: 'Newest first' },
        { value: 'oldest', description: 'Oldest first' },
      ];
      const matchingOptions = sortOptions.filter(o =>
        o.value.startsWith(partialValue)
      );
      for (const opt of matchingOptions) {
        suggestions.push({
          type: 'value',
          value: `sort:${opt.value}`,
          description: opt.description,
          insertText: `sort:${opt.value}`,
          replaceFrom,
        });
      }
    }
  }

  return suggestions;
}

export interface AutocompleteSuggestion {
  type: 'keyword' | 'value';
  value: string;
  description: string;
  insertText: string;
  replaceFrom?: number;  // Position to start replacing from
  contact?: ContactAutocompleteOption;
}

/**
 * Apply an autocomplete suggestion to the query
 */
export function applySuggestion(
  query: string,
  cursorPosition: number,
  suggestion: AutocompleteSuggestion
): { newQuery: string; newCursorPosition: number } {
  const replaceFrom = suggestion.replaceFrom ?? cursorPosition;
  const replaceTo = suggestion.replaceFrom === undefined
    ? cursorPosition
    : cursorPosition + (query.slice(cursorPosition).match(/^\S*/)?.[0].length ?? 0);
  const beforeReplace = query.slice(0, replaceFrom);
  const afterReplace = query.slice(replaceTo);
  
  // Don't add space after keywords (they end with :), only after completed values
  const isKeyword = suggestion.type === 'keyword' && suggestion.insertText.endsWith(':');
  const suffix = isKeyword ? '' : ' ';
  
  const newQuery = beforeReplace + suggestion.insertText + suffix + afterReplace.trimStart();
  const newCursorPosition = beforeReplace.length + suggestion.insertText.length + suffix.length;

  return { newQuery, newCursorPosition };
}

/**
 * Extract active filters as displayable chips
 */
export function getFilterChips(
  parsed: ParsedQuery,
  contactNames: ReadonlyMap<number, string> = new Map(),
): FilterChip[] {
  const chips: FilterChip[] = [];

  // Show each source as a separate chip
  if (parsed.source) {
    for (const source of parsed.source.split(',')) {
      chips.push({ key: 'source', value: source, label: `Source · ${sourceLabel(source)}` });
    }
  }
  // Show each type as a separate chip
  if (parsed.type) {
    for (const type of parsed.type.split(',')) {
      chips.push({ key: 'type', value: type, label: `type:${type}` });
    }
  }
  // If date: was used, show it as a single chip
  if (parsed.date) {
    chips.push({ key: 'date', value: parsed.date, label: `date:${parsed.date}` });
  } else {
    // Otherwise show after:/before: separately
    if (parsed.startDate) {
      chips.push({ key: 'after', value: parsed.startDate, label: `after:${parsed.startDate}` });
    }
    if (parsed.endDate) {
      chips.push({ key: 'before', value: parsed.endDate, label: `before:${parsed.endDate}` });
    }
  }
  if (parsed.from) {
    chips.push({ key: 'from', value: parsed.from, label: `from:${parsed.from}` });
  }
  if (parsed.location) {
    chips.push({ key: 'at', value: parsed.location, label: `at:${parsed.location}` });
  }
  if (parsed.contact !== undefined) {
    const contactId = parseContactFilterId(parsed.contact);
    const contactName = contactId === undefined ? undefined : contactNames.get(contactId);
    chips.push({
      key: 'contact',
      value: parsed.contact,
      label: contactName
        ? `Contact · ${contactName}`
        : contactId === undefined
          ? "Invalid contact"
          : `Contact · #${contactId}`,
    });
  }
  if (parsed.chat) {
    chips.push({ key: 'chat', value: parsed.chat, label: `chat:${parsed.chat}` });
  }
  if (parsed.sort) {
    chips.push({ key: 'sort', value: parsed.sort, label: `sort:${parsed.sort}` });
  }

  return chips;
}

export interface FilterChip {
  key: string;
  value: string;
  label: string;
}

/**
 * Remove a specific filter from the query string
 * @param filterKey - The filter type (e.g., 'source', 'type')
 * @param filterValue - The specific value to remove (e.g., 'discord')
 */
export function removeFilter(query: string, filterKey: string, filterValue?: string): string {
  if (filterValue !== undefined) {
    // Remove specific filter:value (e.g., source:discord)
    // Handle both quoted and unquoted values
    if (filterValue === '') {
      return query.replace(new RegExp(`\\b${filterKey}:\\s*`, 'gi'), '').trim();
    }
    const escapedValue = filterValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${filterKey}:(${escapedValue}|"${escapedValue}")\\s*`, 'gi');
    return query.replace(regex, '').trim();
  } else {
    // Remove all instances of this filter type
    const regex = new RegExp(`\\b${filterKey}:("([^"]+)"|(\\S+))\\s*`, 'gi');
    return query.replace(regex, '').trim();
  }
}
