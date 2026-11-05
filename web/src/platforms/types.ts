import type { PlatformMeta } from "@platforms/types";
import type { IconComponent } from "../ui/icons";

/** Web half of a platform module. Loaded on every page, so it must not import views. */
export interface PlatformDisplay<Meta extends PlatformMeta = PlatformMeta> {
  meta: Meta;
  /** Shown for the platform's sources unless `sourceIcons` overrides it. */
  icon: IconComponent;
  sourceIcons?: Partial<Record<Meta["sources"][number]["id"], IconComponent>>;
}
