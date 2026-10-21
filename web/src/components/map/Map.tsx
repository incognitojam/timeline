import { onMount, onCleanup, createEffect, on } from "solid-js";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, MapOptions } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MAP_STYLE_URL, DEFAULT_CENTER, DEFAULT_ZOOM } from "./mapStyles";

interface Props {
  class?: string;
  center?: [number, number];
  zoom?: number;
  style?: string;
  onMapReady?: (map: MapLibreMap) => void;
}

export default function Map(props: Props) {
  let container: HTMLDivElement | undefined;
  let map: MapLibreMap | undefined;
  let resizeObserver: ResizeObserver | undefined;

  onMount(() => {
    if (!container) return;

    const options: MapOptions = {
      container,
      style: props.style ?? MAP_STYLE_URL,
      center: props.center ?? DEFAULT_CENTER,
      zoom: props.zoom ?? DEFAULT_ZOOM,
    };

    map = new maplibregl.Map(options);

    // Wait for map to load before notifying parent
    map.on("load", () => {
      if (map) {
        props.onMapReady?.(map);
      }
    });

    // Re-notify parent when style changes (for marker re-creation)
    map.on("style.load", () => {
      if (map) {
        props.onMapReady?.(map);
      }
    });

    // Handle container resize
    resizeObserver = new ResizeObserver(() => {
      map?.resize();
    });
    resizeObserver.observe(container);
  });

  // Handle style changes
  createEffect(
    on(
      () => props.style,
      (newStyle) => {
        if (map && newStyle) {
          map.setStyle(newStyle);
        }
      },
      { defer: true }
    )
  );

  onCleanup(() => {
    resizeObserver?.disconnect();
    map?.remove();
  });

  return (
    <div
      ref={container}
      class={props.class ?? "w-full h-full"}
    />
  );
}
