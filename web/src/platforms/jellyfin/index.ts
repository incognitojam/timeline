import { jellyfinMeta } from "@platforms/jellyfin/meta";
import { IconJellyfin } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const jellyfinDisplay: PlatformDisplay<typeof jellyfinMeta> = { meta: jellyfinMeta, icon: IconJellyfin };
