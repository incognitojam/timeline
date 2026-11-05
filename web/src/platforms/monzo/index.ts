import { monzoMeta } from "@platforms/monzo/meta";
import { IconMonzo } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const monzoDisplay: PlatformDisplay<typeof monzoMeta> = { meta: monzoMeta, icon: IconMonzo };
