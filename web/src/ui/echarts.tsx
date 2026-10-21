import { type EChartsOption, type EChartsType, init } from "echarts";
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";

interface EChartsAutoSizeProps {
  option: EChartsOption;
  waitForFont?: boolean;
}

function withFont(option: EChartsOption, fontFamily: string): EChartsOption {
  if (option.baseOption) {
    return { ...option, baseOption: withFont(option.baseOption, fontFamily) };
  }
  return { ...option, textStyle: { fontFamily, ...option.textStyle } };
}

function withMotion(option: EChartsOption, reduced: boolean, partial = false, inheritedAnimation: EChartsOption["animation"] = true): EChartsOption {
  if (option.baseOption) {
    return {
      ...(!partial && option),
      baseOption: withMotion(option.baseOption, reduced, partial, inheritedAnimation),
      media: option.media?.map((entry) => ({ ...entry, option: withMotion(entry.option as EChartsOption, reduced, partial, option.baseOption?.animation ?? inheritedAnimation) })),
    };
  }
  const animation = reduced ? false : option.animation ?? inheritedAnimation;
  const series = option.series;
  return {
    ...(!partial && option),
    ...(option.textStyle && { textStyle: option.textStyle }),
    animation,
    ...(series && { series: (Array.isArray(series) ? series : [series]).map((entry) => ({
      ...(!partial && entry),
      ...(entry.id !== undefined && { id: entry.id }),
      animation: reduced ? false : entry.animation ?? animation,
    })) }),
  };
}

/** Fills a parent with an explicit height. Options use ECharts' normal merge semantics. */
export function EChartsAutoSize(props: EChartsAutoSizeProps) {
  let container: HTMLDivElement | undefined;
  const [busy, setBusy] = createSignal(true);
  const options = createMemo(() => props.option);

  onMount(() => {
    const element = container;
    if (!element) throw new Error("Chart container was not mounted");

    const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim();
    if (!fontFamily) throw new Error("Chart font theme is missing --font-sans");
    const font = `12px ${fontFamily}`;
    const [fontReady, setFontReady] = createSignal(document.fonts.check(font));
    let fontPending = !fontReady();
    const [chart, setChart] = createSignal<EChartsType>();
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const [reducedMotion, setReducedMotion] = createSignal(motion.matches);
    const updateMotion = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    motion.addEventListener("change", updateMotion);
    let frame: number | undefined;
    let disposed = false;
    let rendered = false;

    const updateBusy = (instance: EChartsType) => {
      setBusy(!rendered || fontPending || frame !== undefined
        || instance.getWidth() !== element.clientWidth || instance.getHeight() !== element.clientHeight);
    };
    const beginRender = () => {
      rendered = false;
      setBusy(true);
    };

    // ECharts caches text widths by font. Keep its fallback family until the web
    // font loads so fallback measurements never enter Inter's cache.
    if (!fontReady()) {
      void document.fonts.load(font).then(
        () => {
          if (disposed) return;
          fontPending = false;
          setFontReady(true);
          resize();
        },
        (error: unknown) => {
          if (disposed) return;
          fontPending = false;
          console.warn("Could not load chart font", error);
          resize();
        },
      );
    }

    const resize = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      if (props.waitForFont && fontPending) return;
      const width = element.clientWidth;
      const height = element.clientHeight;
      // Hidden panels are initialized when they first have a usable size.
      if (width <= 0 || height <= 0) return;

      const instance = chart();
      if (!instance) {
        const initialized = init(element, undefined, { width, height });
        initialized.on("finished", () => {
          rendered = true;
          updateBusy(initialized);
        });
        setChart(initialized);
      } else if (instance.getWidth() !== width || instance.getHeight() !== height) {
        beginRender();
        instance.resize({ width, height });
      } else {
        updateBusy(instance);
      }
    };

    const observer = new ResizeObserver(() => {
      setBusy(true);
      if (frame === undefined) frame = requestAnimationFrame(resize);
    });

    onCleanup(() => {
      disposed = true;
      motion.removeEventListener("change", updateMotion);
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      chart()?.dispose();
    });

    createEffect(
      on(
        [chart, options, fontReady, reducedMotion],
        ([instance, option, ready, reduced], previous) => {
          if (!instance) return;
          // Preference/font changes must not replay initial zoom/legend settings.
          const appearanceOnly = Boolean(previous && previous[0] === instance && previous[1] === option);
          const nextOption = withMotion(ready ? withFont(option, fontFamily) : option, reduced, appearanceOnly);
          beginRender();
          const width = element.clientWidth;
          const height = element.clientHeight;
          if (width > 0 && height > 0 && (instance.getWidth() !== width || instance.getHeight() !== height)) {
            // Resize consumes the pending option, so labels never render for the new
            // layout on the old canvas while waiting for the resize observer's frame.
            instance.setOption(nextOption, { lazyUpdate: true });
            instance.resize({ width, height });
            instance.getZr().flush();
          } else {
            instance.setOption(nextOption);
          }
        },
      ),
    );

    observer.observe(element);
    resize();
  });

  return <div ref={container} data-chart aria-busy={busy()} style={{ width: "100%", height: "100%" }} />;
}
