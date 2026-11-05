import { githubMeta } from "@platforms/github/meta";
import { IconGitHub } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const githubDisplay: PlatformDisplay<typeof githubMeta> = { meta: githubMeta, icon: IconGitHub };
