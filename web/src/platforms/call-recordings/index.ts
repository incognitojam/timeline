import { callRecordingsMeta } from "@platforms/call-recordings/meta";
import { IconRecordVoiceOver } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const callRecordingsDisplay: PlatformDisplay<typeof callRecordingsMeta> = { meta: callRecordingsMeta, icon: IconRecordVoiceOver };
