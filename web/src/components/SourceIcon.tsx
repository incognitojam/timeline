import type { ComponentProps } from "solid-js";
import { mergeProps, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import { getSourceIcon } from "../lib/source-styles";

type SourceIconProps = { source: string } & ComponentProps<"svg">;

/**
 * Renders a source as a monochrome SVG that inherits the surrounding source
 * colour. Unknown sources use a neutral circle so this always has one shape.
 */
export default function SourceIcon(props: SourceIconProps) {
  const [local, svgProps] = splitProps(props, ["source"]);
  const merged = mergeProps(
    { class: "align-[-0.125em]", width: "1em", height: "1em", "aria-hidden": true },
    svgProps,
  );
  return <Dynamic component={getSourceIcon(local.source)} {...merged} />;
}
