import { opencodeMeta } from "@platforms/opencode/meta";
import { IconBuild } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const opencodeDisplay: PlatformDisplay<typeof opencodeMeta> = { meta: opencodeMeta, icon: IconBuild };
