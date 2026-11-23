import type { PlatformModule } from "../registry";
import { callRecordingsMeta } from "./meta";

export const callRecordingsPlatform: PlatformModule = {
  meta: callRecordingsMeta,
  loadSeeds: async () => [(await import("./seed")).callRecordingsSeed],
};
