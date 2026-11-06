// Claude Code wraps a few kinds of protocol data as pseudo-XML tags inside
// text blocks — slash command invocations, local command output, caveats,
// bash input/output. The markdown renderer has `skipHtml: true`, so those
// tags collapse to their inner text concatenated together (e.g.
// `<command-name>/copy</command-name><command-message>copy</command-message>`
// renders as `/copycopy`). This helper rewrites them to real markdown before
// the text hits the renderer.

export function rewriteClaudeCodeMarkup(text: string): string {
  return text
    // Slash command invocation: render as `**/name** args` and drop the
    // redundant command-message (which is just the name without the slash).
    .replace(
      /<command-name>([^<]+)<\/command-name>\s*<command-message>[^<]*<\/command-message>\s*<command-args>([^<]*)<\/command-args>/gs,
      (_m, name, args) => {
        const trimmedArgs = args.trim();
        return trimmedArgs ? `**${name}** ${trimmedArgs}` : `**${name}**`;
      }
    )
    // Lone command tags (in case they appear without the full triplet).
    .replace(/<command-name>([^<]+)<\/command-name>/g, "**$1**")
    .replace(/<command-message>[^<]*<\/command-message>/g, "")
    .replace(/<command-args>[^<]*<\/command-args>/g, "")
    // Local slash-command output → fenced code block (muted).
    .replace(
      /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g,
      (_m, body) => {
        const trimmed = body.trim();
        return trimmed ? `\n\n\`\`\`\n${trimmed}\n\`\`\`\n\n` : "";
      }
    )
    // Caveat preamble → blockquote so it's clearly set apart.
    .replace(
      /<local-command-caveat>([\s\S]*?)<\/local-command-caveat>/g,
      (_m, body) => {
        const trimmed = body.trim();
        if (!trimmed) return "";
        const quoted = trimmed.split("\n").map((l: string) => `> ${l}`).join("\n");
        return `\n\n${quoted}\n\n`;
      }
    )
    // Bash execution blocks.
    .replace(
      /<bash-input>([\s\S]*?)<\/bash-input>/g,
      (_m, body) => `\n\n\`\`\`bash\n$ ${body.trim()}\n\`\`\`\n\n`
    )
    .replace(
      /<bash-stdout>([\s\S]*?)<\/bash-stdout>/g,
      (_m, body) => {
        const trimmed = body.trim();
        return trimmed ? `\n\n\`\`\`\n${trimmed}\n\`\`\`\n\n` : "";
      }
    )
    .replace(
      /<bash-stderr>([\s\S]*?)<\/bash-stderr>/g,
      (_m, body) => {
        const trimmed = body.trim();
        return trimmed ? `\n\n\`\`\`\n${trimmed}\n\`\`\`\n\n` : "";
      }
    )
    // Reference to output that was too large to inline.
    .replace(/<persisted-output>([\s\S]*?)<\/persisted-output>/g, "_$1_");
}
