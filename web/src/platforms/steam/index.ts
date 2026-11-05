import { steamMeta } from "@platforms/steam/meta";
import { IconSteam } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const steamDisplay: PlatformDisplay<typeof steamMeta> = { meta: steamMeta, icon: IconSteam };
