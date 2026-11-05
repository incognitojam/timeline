import { chatgptMeta } from "@platforms/chatgpt/meta";
import { IconOpenAI } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const chatgptDisplay: PlatformDisplay<typeof chatgptMeta> = { meta: chatgptMeta, icon: IconOpenAI };
