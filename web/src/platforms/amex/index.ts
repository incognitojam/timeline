import { amexMeta } from "@platforms/amex/meta";
import { IconAmericanExpress } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const amexDisplay: PlatformDisplay<typeof amexMeta> = { meta: amexMeta, icon: IconAmericanExpress };
