import { wakatimeMeta } from "@platforms/wakatime/meta";
import { IconWakaTime } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const wakatimeDisplay: PlatformDisplay<typeof wakatimeMeta> = { meta: wakatimeMeta, icon: IconWakaTime };
