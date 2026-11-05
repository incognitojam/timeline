import { claudeCodeMeta } from "@platforms/claude-code/meta";
import { IconClaude } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const claudeCodeDisplay: PlatformDisplay<typeof claudeCodeMeta> = { meta: claudeCodeMeta, icon: IconClaude };
