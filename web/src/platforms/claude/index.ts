import { claudeMeta } from "@platforms/claude/meta";
import { IconClaude } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const claudeDisplay: PlatformDisplay<typeof claudeMeta> = { meta: claudeMeta, icon: IconClaude };
