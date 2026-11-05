import { spotifyMeta } from "@platforms/spotify/meta";
import { IconSpotify } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const spotifyDisplay: PlatformDisplay<typeof spotifyMeta> = { meta: spotifyMeta, icon: IconSpotify };
