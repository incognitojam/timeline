import * as RadioGroup from "@kobalte/core/radio-group";
import { For, type JSX, Show } from "solid-js";
import { IconCheck } from "./icons";

/**
 * Joined "split button" grammar, shared by every segmented group in the app:
 * one bordered track, hairline dividers between flat segments, and a tinted
 * selected state. The filled primary treatment stays reserved for primary
 * CTAs, so selection reads as `bg-primary/10 text-primary` here.
 *
 * Both controls in this module render these classes — this is the only place
 * the group/segment styling is defined.
 */
const GROUP_CLASS = "divide-x divide-border overflow-hidden rounded-md border border-border";

const SEGMENT_CLASS =
  "inline-flex min-h-8 shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap px-3 text-sm transition-colors motion-reduce:transition-none";

function segmentToneClass(selected: boolean): string {
  return selected
    ? "bg-primary/10 text-primary"
    : "text-muted-foreground hover:bg-accent hover:text-foreground";
}

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: JSX.Element;
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  class?: string;
  disabled?: boolean;
  label?: string;
  invalid?: boolean;
  describedBy?: string;
  /**
   * Split the group's width evenly between its segments instead of sizing
   * each one to its label. Combine with a width or flex utility in `class`
   * (e.g. `class="flex-1 sm:flex-none"`) to control how wide the group gets.
   */
  fill?: boolean;
}

/**
 * Single-select segmented control. Wraps Kobalte's RadioGroup, which provides
 * radiogroup semantics: one tab stop, arrow-key selection, native disabled
 * behaviour, and an accessible name from `label`.
 */
export default function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  return (
    <RadioGroup.Root
      value={props.value}
      disabled={props.disabled}
      aria-label={props.label}
      aria-invalid={props.invalid || undefined}
      aria-describedby={props.describedBy}
      onChange={(value) => {
        if (value) props.onChange(value as T);
      }}
      orientation="horizontal"
      class={`${props.fill ? "flex" : "inline-flex"} ${GROUP_CLASS} data-[disabled]:cursor-default data-[disabled]:opacity-50 ${props.class ?? ""}`}
    >
      <For each={props.options}>
        {(option) => (
          <RadioGroup.Item
            value={option.value}
            class={`relative flex ${props.fill ? "flex-1" : ""}`}
          >
            {/* Visually hidden radio: owns focus, so the label mirrors its focus ring. */}
            <RadioGroup.ItemInput class="peer" />
            <RadioGroup.ItemLabel
              class={`${SEGMENT_CLASS} grow ${segmentToneClass(props.value === option.value)} peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-ring data-[disabled]:pointer-events-none data-[disabled]:cursor-default`}
            >
              {option.label}
            </RadioGroup.ItemLabel>
          </RadioGroup.Item>
        )}
      </For>
    </RadioGroup.Root>
  );
}

interface SegmentedToggleGroupProps {
  /** Accessible name for the group of independent toggles. */
  label: string;
  class?: string;
  children: JSX.Element;
}

/**
 * Joined group of independent on/off toggles, sharing the segmented control's
 * visual grammar. Use it when more than one segment can be active at once;
 * use {@link SegmentedControl} when exactly one segment is selected.
 */
export function SegmentedToggleGroup(props: SegmentedToggleGroupProps) {
  return (
    <div
      role="group"
      aria-label={props.label}
      class={`inline-flex ${GROUP_CLASS} ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  );
}

interface SegmentedToggleProps {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  children: JSX.Element;
  title?: string;
  disabled?: boolean;
}

/** A single toggle inside a {@link SegmentedToggleGroup}. */
export function SegmentedToggle(props: SegmentedToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      title={props.title}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.pressed)}
      class={`${SEGMENT_CLASS} ${segmentToneClass(props.pressed)} focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:cursor-default disabled:opacity-50`}
    >
      <Show when={props.pressed}>
        <IconCheck class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </Show>
      {props.children}
    </button>
  );
}
