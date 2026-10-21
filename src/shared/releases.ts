export interface TimelineRelease {
  version: string;
  url: string;
  publishedAt: string;
  notes: string;
  downloadUrl: string | null;
}

export interface ReleaseStatus {
  latest: TimelineRelease;
  comparison: "update-available" | "current" | "ahead" | "unknown";
  checkedAt: string;
}
