import type { PlatformModule } from "../registry";
import { callRecordingsMeta } from "./meta";
import { callRecordingsSyncSource } from "./sync";

export const callRecordingsPlatform: PlatformModule = {
  meta: callRecordingsMeta,
  syncSources: [callRecordingsSyncSource],
  loadSeeds: async () => [(await import("./seed")).callRecordingsSeed],
};
