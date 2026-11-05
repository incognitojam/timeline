import { traktMeta } from "@platforms/trakt/meta";
import { IconTrakt } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const traktDisplay: PlatformDisplay<typeof traktMeta> = { meta: traktMeta, icon: IconTrakt };
