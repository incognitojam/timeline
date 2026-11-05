import { phoneMeta } from "@platforms/phone/meta";
import { IconPhone } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const phoneDisplay: PlatformDisplay<typeof phoneMeta> = { meta: phoneMeta, icon: IconPhone };
