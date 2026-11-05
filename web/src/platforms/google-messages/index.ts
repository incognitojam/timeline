import { googleMessagesMeta } from "@platforms/google-messages/meta";
import { IconGoogleMessages } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const googleMessagesDisplay: PlatformDisplay<typeof googleMessagesMeta> = { meta: googleMessagesMeta, icon: IconGoogleMessages };
