import { instagramMeta } from "@platforms/instagram/meta";
import { IconInstagram } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const instagramDisplay: PlatformDisplay<typeof instagramMeta> = { meta: instagramMeta, icon: IconInstagram };
