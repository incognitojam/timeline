import { swarmMeta } from "@platforms/swarm/meta";
import { IconSwarm } from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const swarmDisplay: PlatformDisplay<typeof swarmMeta> = { meta: swarmMeta, icon: IconSwarm };
