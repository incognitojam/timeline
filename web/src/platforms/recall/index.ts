import { recallMeta } from "@platforms/recall/meta";
import { IconScreenshotMonitor } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const recallDisplay: PlatformDisplay<typeof recallMeta> = { meta: recallMeta, icon: IconScreenshotMonitor };
