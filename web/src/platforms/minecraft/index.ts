import { minecraftMeta } from "@platforms/minecraft/meta";
import { IconMinecraft } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const minecraftDisplay: PlatformDisplay<typeof minecraftMeta> = { meta: minecraftMeta, icon: IconMinecraft };
