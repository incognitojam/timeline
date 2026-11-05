import type { PlatformMeta } from "@platforms/types";
import type { IconComponent } from "../ui/icons";

/** Web half of a platform module. Loaded on every page, so it must not import views. */
export interface PlatformDisplay {
  meta: PlatformMeta;
  /** Shown for all of the platform's sources. */
  icon: IconComponent;
}
