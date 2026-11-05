import { redditMeta } from "@platforms/reddit/meta";
import { IconReddit } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const redditDisplay: PlatformDisplay<typeof redditMeta> = { meta: redditMeta, icon: IconReddit };
