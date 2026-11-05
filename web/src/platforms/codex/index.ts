import { codexMeta } from "@platforms/codex/meta";
import { IconOpenAI } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const codexDisplay: PlatformDisplay<typeof codexMeta> = { meta: codexMeta, icon: IconOpenAI };
