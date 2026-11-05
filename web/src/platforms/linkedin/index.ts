import { linkedinMeta } from "@platforms/linkedin/meta";
import { IconLinkedIn } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const linkedinDisplay: PlatformDisplay<typeof linkedinMeta> = { meta: linkedinMeta, icon: IconLinkedIn };
