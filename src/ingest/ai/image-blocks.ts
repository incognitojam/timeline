import { join } from "path";
import { imageDimensions } from "../../media/dimensions";
import { storeFile, type StoreFileResult } from "../../media/storage";
import type { ContentBlock } from "./format-content";

export interface StoredImageAttachment {
  sourceId: string;
  filename: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  stored: StoreFileResult;
}

export interface StoredImageBlocks {
  blocks: ContentBlock[];
  attachments: StoredImageAttachment[];
}

export interface StoredImageRawContent {
  content: unknown[];
  attachments: StoredImageAttachment[];
}

export interface StoreImageContentOptions {
  source: string;
  sourceLabel: string;
  loggerPrefix: string;
  sourceAccount: string;
  sessionId: string;
  messageId: string;
}

export interface StoreDecodedImageOptions extends StoreImageContentOptions {
  content: Uint8Array;
  sourceId: string;
  filenameId: string;
  mediaType: string;
  messageIdLabel?: string;
}

export function attachmentPathId(path: readonly string[]): string {
  return path.join(".");
}

export function filenamePathId(path: readonly string[]): string {
  const cleaned = attachmentPathId(path).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) throw new Error("Cannot build image filename from empty block path");
  return cleaned;
}

export function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function safePathPart(value: string, label: string, sourceLabel: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned) throw new Error(`Cannot build ${sourceLabel} media path: empty ${label}`);
  return cleaned;
}

export function imageExtensionsForMimeType(mimeType: string, sourceLabel: string): string[] {
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (!normalized.startsWith("image/")) {
    throw new Error(`${sourceLabel} image block has non-image media_type: ${mimeType}`);
  }

  switch (normalized) {
    case "image/jpeg":
    case "image/pjpeg":
      return [".jpg", ".jpeg"];
    case "image/png":
      return [".png"];
    case "image/gif":
      return [".gif"];
    case "image/webp":
      return [".webp"];
    case "image/avif":
      return [".avif"];
    case "image/svg+xml":
      return [".svg"];
    default: {
      const subtype = normalized.slice("image/".length).split("+")[0] ?? "";
      const cleaned = subtype.replace(/[^a-z0-9]/g, "");
      if (!cleaned) {
        throw new Error(`Cannot derive extension from ${sourceLabel} media_type: ${mimeType}`);
      }
      return [`.${cleaned}`];
    }
  }
}

export function imageExtensionFromMimeType(mimeType: string, sourceLabel: string): string {
  return imageExtensionsForMimeType(mimeType, sourceLabel)[0];
}

export function decodeBase64ImageData(data: string, blockPath: string, sourceLabel: string): Buffer {
  const cleaned = data.replace(/\s/g, "");
  if (cleaned.length === 0) {
    throw new Error(`${sourceLabel} image block ${blockPath} has empty base64 data`);
  }

  const content = Buffer.from(cleaned, "base64");
  const normalizedInput = cleaned.replace(/=+$/, "");
  const normalizedOutput = content.toString("base64").replace(/=+$/, "");
  if (normalizedOutput !== normalizedInput) {
    throw new Error(`${sourceLabel} image block ${blockPath} has invalid base64 data`);
  }

  return content;
}

function contentPathLabel(path: readonly string[]): string {
  let out = "content";
  for (const part of path) {
    out += /^\d+$/.test(part) ? `[${part}]` : `.${part}`;
  }
  return out;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function storeDecodedImage(
  options: StoreDecodedImageOptions
): Promise<StoredImageAttachment> {
  const extension = imageExtensionFromMimeType(options.mediaType, options.sourceLabel);
  const filename = `image-${options.filenameId}${extension}`;
  const stored = await storeFile({
    source: options.source,
    relativePath: join(
      safePathPart(options.sourceAccount, "sourceAccount", options.sourceLabel),
      safePathPart(options.sessionId, "sessionId", options.sourceLabel),
      safePathPart(
        options.messageId,
        options.messageIdLabel ?? "messageId",
        options.sourceLabel
      ),
      filename,
    ),
    content: options.content,
  });

  let dimensions: { width: number; height: number } | null = null;
  try {
    dimensions = await imageDimensions(options.content);
  } catch {
    // Dimension extraction is best-effort; storage and rendering still work.
  }

  return {
    sourceId: options.sourceId,
    filename,
    mimeType: options.mediaType,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    stored,
  };
}

async function storeImageRecord(options: StoreImageContentOptions & {
  record: Record<string, unknown>;
  path: string[];
  attachments: StoredImageAttachment[];
}): Promise<{ value: unknown; changed: boolean }> {
  const source = recordFromUnknown(options.record.source);
  const sourceType = stringField(source, "type");
  const data = stringField(source, "data");
  if (sourceType !== "base64" || data === undefined) {
    return { value: options.record, changed: false };
  }

  const blockPath = attachmentPathId(options.path);
  const mediaType =
    nonEmptyString(stringField(options.record, "media_type")) ??
    nonEmptyString(stringField(source, "media_type")) ??
    nonEmptyString(stringField(source, "mediaType"));

  try {
    if (!mediaType) {
      throw new Error(`${options.sourceLabel} image block ${blockPath} is missing media_type`);
    }

    const content = decodeBase64ImageData(data, blockPath, options.sourceLabel);
    const attachment = await storeDecodedImage({
      ...options,
      content,
      sourceId: blockPath,
      filenameId: filenamePathId(options.path),
      mediaType,
    });

    options.attachments.push(attachment);

    return {
      value: {
        type: "image",
        media_type: mediaType,
      },
      changed: true,
    };
  } catch (error) {
    console.warn(
      `${options.loggerPrefix}: leaving inline image for ${options.sessionId}:${options.messageId} at ${contentPathLabel(options.path)}: ${errorMessage(error)}`
    );
    return { value: options.record, changed: false };
  }
}

async function storeImageValue(options: StoreImageContentOptions & {
  value: unknown;
  path: string[];
  attachments: StoredImageAttachment[];
}): Promise<{ value: unknown; changed: boolean }> {
  const record = recordFromUnknown(options.value);
  if (!record) return { value: options.value, changed: false };

  if (stringField(record, "type") === "image") {
    return storeImageRecord({
      ...options,
      record,
    });
  }

  if (stringField(record, "type") === "tool_result" && Array.isArray(record.content)) {
    const nested = await storeImageValues({
      ...options,
      values: record.content,
      path: [...options.path, "content"],
    });
    if (!nested.changed) return { value: options.value, changed: false };
    return {
      value: {
        ...record,
        content: nested.values,
      },
      changed: true,
    };
  }

  return { value: options.value, changed: false };
}

async function storeImageValues(options: StoreImageContentOptions & {
  values: unknown[];
  path?: string[];
  attachments: StoredImageAttachment[];
}): Promise<{ values: unknown[]; changed: boolean }> {
  let changed = false;
  const values: unknown[] = [];
  const basePath = options.path ?? [];

  for (let index = 0; index < options.values.length; index++) {
    const result = await storeImageValue({
      ...options,
      value: options.values[index],
      path: [...basePath, String(index)],
    });
    values.push(result.value);
    changed = changed || result.changed;
  }

  return { values, changed };
}

export async function storeImageRawContent(options: StoreImageContentOptions & {
  content: unknown[];
}): Promise<StoredImageRawContent> {
  const attachments: StoredImageAttachment[] = [];
  const result = await storeImageValues({
    ...options,
    values: options.content,
    attachments,
  });
  return { content: result.values, attachments };
}

export async function storeImageBlocks(options: StoreImageContentOptions & {
  blocks: ContentBlock[];
}): Promise<StoredImageBlocks> {
  const result = await storeImageRawContent({
    ...options,
    content: options.blocks,
  });
  return {
    blocks: result.content as ContentBlock[],
    attachments: result.attachments,
  };
}
