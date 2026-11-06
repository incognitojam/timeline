import type { PlatformModule } from "../registry";
import { phoneMeta } from "./meta";

export const phonePlatform: PlatformModule = {
  meta: phoneMeta,
  loadSeeds: async () => [(await import("./seed")).smsBackupRestoreSeed],
};
