import { t3codeMeta } from "@platforms/t3code/meta";
import { IconCode } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const t3codeDisplay: PlatformDisplay<typeof t3codeMeta> = { meta: t3codeMeta, icon: IconCode };
