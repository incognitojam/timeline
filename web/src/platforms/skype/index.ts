import { skypeMeta } from "@platforms/skype/meta";
import { IconSimpleSkype } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const skypeDisplay: PlatformDisplay<typeof skypeMeta> = { meta: skypeMeta, icon: IconSimpleSkype };
