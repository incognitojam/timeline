import { readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { z } from "zod";
import { extractZip, cleanupExtract } from "../../inbox/zip";
import { readJsonArray } from "./json-array";

export const categoryPattern = /^(light_metadata|projects|memories|feedback|design_chats|frames|conversations)-(\d{3})(?: \(\d+\))?\.zip$/;
const timestamp = z.string().refine((s) => Number.isFinite(Date.parse(s)), "Invalid timestamp");
export const conversationSchema = z.object({
  uuid: z.string().min(1), name: z.string(), summary: z.string().nullish(),
  created_at: timestamp, updated_at: timestamp,
  account: z.object({ uuid: z.string().min(1) }).passthrough().optional(),
  chat_messages: z.array(z.object({
    uuid: z.string().min(1), text: z.string().nullish(), sender: z.enum(["human", "assistant"]),
    created_at: timestamp, updated_at: timestamp.nullish(),
    content: z.array(z.unknown()).optional(), attachments: z.array(z.unknown()).optional(),
    files: z.array(z.unknown()).optional(), parent_message_uuid: z.string().nullable().optional(),
  }).passthrough()),
}).passthrough();

export function parseConversation(value: unknown) {
  const result = conversationSchema.safeParse(value);
  if (result.success) return result.data;
  const uuid = value && typeof value === "object" && "uuid" in value && typeof value.uuid === "string" ? value.uuid : "missing";
  throw new Error(`Claude conversation ${uuid}: ${result.error.message}`);
}

export async function exportZips(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) return [path];
  const names = await readdir(path);
  const files = names.filter((name) => /\.zip$/i.test(name)).sort();
  const unknown = files.filter((name) => !categoryPattern.test(name));
  if (unknown.length) throw new Error(`Unrecognised ZIPs in Claude folder: ${unknown.join(", ")}`);
  if (!files.length) throw new Error("No Claude category ZIPs found in folder");
  const parts = new Map<string, number[]>();
  const canonical = new Set<string>();
  for (const file of files) {
    const match = categoryPattern.exec(file);
    if (!match) throw new Error("Unrecognised Claude ZIP");
    const indices = parts.get(match[1]) ?? [];
    indices.push(Number(match[2]));
    parts.set(match[1], indices);
    canonical.add(`${match[1]}-${match[2]}.zip`);
  }
  for (const [category, indices] of parts) {
    if (indices.some((part, index) => part !== index)) throw new Error(`Claude ${category} parts must be unique and contiguous from 000`);
  }
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    const value: unknown = await Bun.file(join(path, name)).json();
    if (!value || typeof value !== "object" || !("data_files" in value)) continue;
    const manifest = z.object({ version: z.literal("1.0"), data_files: z.array(z.object({ filename: z.string() })) }).parse(value);
    const missing = manifest.data_files.map((file) => file.filename).filter((file) => !canonical.has(file));
    if (missing.length) throw new Error(`Claude manifest lists missing files: ${missing.join(", ")}`);
  }
  return files.map((name) => join(path, name));
}

export async function detectClaudeCategory(zipPath: string, root: string, files: string[]): Promise<boolean> {
  const category = categoryPattern.exec(basename(zipPath))?.[1];
  const names = files.map((file) => relative(root, file));
  if (category && category !== "conversations") {
    const matches = category === "light_metadata"
      ? names.includes("users.json") && names.includes("login_history.json")
      : names.some((name) => name.startsWith(`${category === "feedback" ? "reflections" : category === "frames" ? "artifacts" : category}/`));
    if (!matches) throw new Error("Claude category ZIP does not match its contents");
    return true;
  }
  const path = files.find((file) => basename(file) === "conversations.json");
  if (!path) {
    if (category === "conversations") throw new Error("Claude conversations category is missing conversations.json");
    return false;
  }
  for await (const value of readJsonArray(path)) {
    if (category === "conversations") { parseConversation(value); return true; }
    return conversationSchema.safeParse(value).success;
  }
  return category === "conversations";
}

const activeExtracts = new Set<string>();
process.once("exit", () => { for (const dir of activeExtracts) rmSync(dir, { recursive: true, force: true }); });
function cleanStaleExtracts() {
  for (const name of readdirSync(tmpdir())) {
    const match = /^timeline-claude-(\d+)-/.exec(name);
    if (!match) continue;
    try { process.kill(Number(match[1]), 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(join(tmpdir(), name), { recursive: true, force: true });
    }
  }
}
export async function* extractedExports(path: string) {
  cleanStaleExtracts();
  for (const zipPath of await exportZips(path)) {
    const extracted = await extractZip(zipPath, `timeline-claude-${process.pid}-`);
    activeExtracts.add(extracted.tempDir);
    try {
      yield { ...extracted, zipPath, category: categoryPattern.exec(basename(zipPath))?.[1] };
    } finally {
      await cleanupExtract(extracted.tempDir);
      activeExtracts.delete(extracted.tempDir);
    }
  }
}
