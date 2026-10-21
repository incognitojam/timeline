export interface CorpusFilterTerm {
  source: string;
  type?: string;
}

const ASCII_WHITESPACE = " \t\n\u000b\f\r";

// Sources stay deliberately excluded until they are explicitly added: adding a
// source is a clean incremental run, while removing one requires surgical
// deletes across embedding_documents, embedding_document_events,
// embedding_vectors, and the vec0 table. Add-back candidates include
// google-search (title equals content, so each document collapses to a page
// title), YouTube, Chrome, and recall (OCR of variable quality).
export const EVENT_CORPUS_POLICY = {
  sources: [
    "facebook",
    "discord",
    "skype",
    "reddit",
    "phone",
    "google-messages",
    "claude",
    "chatgpt",
    "claude-code",
    "conductor",
    "codex",
    "amp",
    "t3code",
    "opencode",
    "google-keep",
    "google-calendar",
    "google-chat",
    "instagram",
    "linkedin",
    "github",
    "journal",
    "manual",
  ],
  excluded: [
    { source: "reddit", type: "vote:up" },
    { source: "reddit", type: "vote:down" },
  ],
} as const satisfies { sources: readonly string[]; excluded: readonly CorpusFilterTerm[] };

function uniqueTerms(terms: readonly CorpusFilterTerm[]): CorpusFilterTerm[] {
  const seen = new Set<string>();
  return terms.filter(term => {
    const key = `${term.source}\0${term.type ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function termClause(terms: readonly CorpusFilterTerm[]): { clause: string; params: string[] } {
  const params: string[] = [];
  const parts = uniqueTerms(terms).map(term => {
    if (term.type === undefined) {
      params.push(term.source);
      return "source = ?";
    }
    params.push(term.source, term.type);
    return "(source = ? AND type = ?)";
  });
  return { clause: parts.join(" OR "), params };
}

interface CorpusFilters {
  include: readonly CorpusFilterTerm[];
  exclude: readonly CorpusFilterTerm[];
}

/** Compile the content requirement and default/override corpus filters for events. */
export function buildCorpusWhere(filters: CorpusFilters): { clause: string; params: string[] } {
  const selection = buildCorpusSourceWhere(filters);
  return {
    clause: `content IS NOT NULL AND trim(content, ?) != '' AND ${selection.clause}`,
    params: [ASCII_WHITESPACE, ...selection.params],
  };
}

/** Compile the default/override corpus filters for events, without the content requirement. */
export function buildCorpusSourceWhere(filters: CorpusFilters): { clause: string; params: string[] } {
  const conditions: string[] = [];
  const params: string[] = [];
  const include = termClause(
    filters.include.length > 0 ? filters.include : EVENT_CORPUS_POLICY.sources.map(source => ({ source }))
  );
  conditions.push(`(${include.clause})`);
  params.push(...include.params);

  const policyExclude = termClause(EVENT_CORPUS_POLICY.excluded);
  if (policyExclude.clause) {
    conditions.push(`NOT (${policyExclude.clause})`);
    params.push(...policyExclude.params);
  }

  const exclude = termClause(filters.exclude);
  if (exclude.clause) {
    conditions.push(`NOT (${exclude.clause})`);
    params.push(...exclude.params);
  }

  return { clause: conditions.join(" AND "), params };
}
