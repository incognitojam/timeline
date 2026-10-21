import { Show } from "solid-js";

/**
 * Minimal inline-SVG sparkline. Scales the series between its own min and max
 * so small trends stay visible. Renders nothing for fewer than two points.
 */
export default function Sparkline(props: {
  data: number[];
  width?: number;
  height?: number;
  class?: string;
}) {
  const width = () => props.width ?? 120;
  const height = () => props.height ?? 28;

  const points = () => {
    const data = props.data;
    if (data.length < 2) return "";
    const max = Math.max(...data);
    const min = Math.min(...data);
    const range = max - min || 1;
    const w = width();
    const h = height();
    const pad = 2; // keep the stroke off the edges
    return data
      .map((v, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = h - pad - ((v - min) / range) * (h - pad * 2);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  };

  return (
    <svg
      width={width()}
      height={height()}
      viewBox={`0 0 ${width()} ${height()}`}
      preserveAspectRatio="none"
      class={props.class ?? "text-green-400"}
      aria-hidden="true"
    >
      <Show when={props.data.length >= 2}>
        <polyline
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          points={points()}
        />
      </Show>
    </svg>
  );
}
