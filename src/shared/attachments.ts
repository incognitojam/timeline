export const ATTACHMENT_STATUSES = ["pending", "stored", "failed", "unrecoverable"] as const;

export const MANUAL_ATTACHMENT_DESCRIPTION_PATH_PATTERN = "^/api/attachments/[^/]+/describe(?:\\?.*)?$";

/** Allow manual vision requests to include slow provider model cold starts. */
export const MANUAL_ATTACHMENT_DESCRIPTION_TIMEOUT_MS = 10 * 60 * 1_000;

export const MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION = 2048;

export function isAttachmentDescriptionImageDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= 1 && value <= MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION;
}

export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

export interface AttachmentListItem {
  id: number;
  eventId: number;
  source: string;
  filename: string | null;
  mimeType: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  storagePath: string | null;
  thumbhash: string | null;
  contentHash: string | null;
  status: AttachmentStatus;
  timestamp: string | null;
  description: string | null;
  descriptionModel: string | null;
}

export interface AttachmentsListResponse {
  attachments: AttachmentListItem[];
  nextCursor: string | null;
}

export interface AttachmentDescriptionEntry {
  model: string;
  description: string;
  createdAt: string;
  durationMs: number | null;
}

export interface AttachmentDetail extends AttachmentListItem {
  descriptions: AttachmentDescriptionEntry[];
}

export interface DescribeAttachmentRequest {
  model: string;
  reasoningEffort?: string;
  maxImageDimension?: number;
}

export type DescribeAttachmentResponse = AttachmentDescriptionEntry;

export interface AttachmentsStats {
  total: number;
  byStatus: Record<AttachmentStatus, number>;
  distinctHashes: number;
  descriptionEligibleHashes: number;
  describedHashes: number;
  needingDescription: number;
  byModel: { model: string; count: number }[];
  bySource: { source: string; count: number }[];
}

export interface AttachmentDescriptionHistoryPoint {
  date: string;
  queueDepth: number | null;
  descriptionEligibleHashes: number | null;
  describedHashes: number | null;
  described: number;
  skipped: number;
  failed: number;
  runs: number;
  failedRuns: number;
  deferredRuns: number;
}

export interface AttachmentDescriptionHistoryResponse {
  points: AttachmentDescriptionHistoryPoint[];
}
