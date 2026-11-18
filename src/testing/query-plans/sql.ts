/** Tokenize enough SQLite syntax to split batches without splitting strings or trigger bodies. */
export function tokens(sql: string): string[] {
  return sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|[xX]'(?:[0-9a-fA-F]{2})*'|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|(?:[?:@$][\w$]+)|->>|->|\|\||>=|<=|<>|!=|==|<<|>>|[\w$]+|[^\s]/g)?.filter(t => !t.startsWith("--") && !t.startsWith("/*")) ?? [];
}

export function statements(sql: string): string[] {
  const result: string[] = [];
  let current: string[] = [];
  let depth = 0;
  let trigger = false;
  for (const token of tokens(sql)) {
    current.push(token);
    if (current.slice(0, 4).some(t => t.toUpperCase() === "TRIGGER") && current[0]?.toUpperCase() === "CREATE") trigger = true;
    if (trigger && /^(BEGIN|CASE)$/i.test(token)) depth++;
    if (trigger && /^END$/i.test(token)) depth--;
    if (token === ";" && depth === 0) {
      result.push(current.slice(0, -1).join(" "));
      current = [];
      trigger = false;
    }
  }
  if (current.length) result.push(current.join(" "));
  return result.filter(Boolean);
}

export function identifier(token: string): string {
  return token.replace(/^["`\[]|["`\]]$/g, "").toLowerCase();
}
