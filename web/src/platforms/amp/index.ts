import { ampMeta } from "@platforms/amp/meta";
import { IconBolt } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const ampDisplay: PlatformDisplay<typeof ampMeta> = { meta: ampMeta, icon: IconBolt };
