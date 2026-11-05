import { conductorMeta } from "@platforms/conductor/meta";
import { IconAutoAwesome } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const conductorDisplay: PlatformDisplay<typeof conductorMeta> = { meta: conductorMeta, icon: IconAutoAwesome };
