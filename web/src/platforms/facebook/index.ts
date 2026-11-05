import { facebookMeta } from "@platforms/facebook/meta";
import { IconFacebook } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const facebookDisplay: PlatformDisplay<typeof facebookMeta> = { meta: facebookMeta, icon: IconFacebook };
