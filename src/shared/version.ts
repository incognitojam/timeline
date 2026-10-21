export interface VersionInfo {
  version?: string;
  build?: string;
  commit: string;
  commitFull: string;
  message: string;
  branch: string;
  builtAt?: string;
  dirty?: boolean;
}

export interface TimelineServiceStatus {
  uptime: number;
  startedAt: string;
  version: VersionInfo | null;
}
