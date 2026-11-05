import { discordMeta } from "@platforms/discord/meta";
import { IconDiscord } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const discordDisplay: PlatformDisplay<typeof discordMeta> = { meta: discordMeta, icon: IconDiscord };
