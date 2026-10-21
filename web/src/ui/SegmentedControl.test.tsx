import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import SegmentedControl, { SegmentedToggle, SegmentedToggleGroup } from "./SegmentedControl";

const OPTIONS = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
] as const;

type View = (typeof OPTIONS)[number]["value"];

describe("SegmentedControl", () => {
  it("renders a radiogroup with the selected option checked", () => {
    const { getByRole } = render(() => (
      <SegmentedControl<View> options={OPTIONS} value="month" onChange={() => {}} />
    ));

    expect(getByRole("radiogroup")).toBeInTheDocument();
    expect(getByRole("radio", { name: "Week" })).not.toBeChecked();
    expect(getByRole("radio", { name: "Month" })).toBeChecked();
    expect(getByRole("radio", { name: "Year" })).not.toBeChecked();
  });

  it("names the group for assistive technology", () => {
    const { getByRole } = render(() => (
      <SegmentedControl<View> label="Date range" options={OPTIONS} value="week" onChange={() => {}} />
    ));

    expect(getByRole("radiogroup", { name: "Date range" })).toBeInTheDocument();
  });

  it("calls onChange with the clicked value", () => {
    const onChange = vi.fn();

    const { getByRole } = render(() => (
      <SegmentedControl<View> options={OPTIONS} value="week" onChange={onChange} />
    ));

    fireEvent.click(getByRole("radio", { name: "Year" }));

    expect(onChange).toHaveBeenCalledWith("year");
  });

  it("selects a segment when its visible label is clicked", () => {
    const [value, setValue] = createSignal<View>("week");

    const { getByText, getByRole } = render(() => (
      <SegmentedControl<View> options={OPTIONS} value={value()} onChange={setValue} />
    ));

    fireEvent.click(getByText("Month"));

    expect(value()).toBe("month");
    expect(getByRole("radio", { name: "Month" })).toBeChecked();
    expect(getByRole("radio", { name: "Week" })).not.toBeChecked();
  });

  it("removes interaction affordances when disabled", () => {
    const onChange = vi.fn();

    const { getByRole, getByText } = render(() => (
      <SegmentedControl<View>
        options={OPTIONS}
        value="week"
        disabled
        onChange={onChange}
      />
    ));

    const year = getByRole("radio", { name: "Year" });
    expect(year).toBeDisabled();
    expect(getByRole("radiogroup")).toHaveAttribute("aria-disabled", "true");
    expect(getByText("Year")).toHaveClass("data-[disabled]:pointer-events-none");

    fireEvent.click(year);

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("SegmentedToggleGroup", () => {
  function Toggles(props: { disabled?: boolean }) {
    const [reactions, setReactions] = createSignal(false);
    const [anonymise, setAnonymise] = createSignal(true);

    return (
      <SegmentedToggleGroup label="Formatting options">
        <SegmentedToggle pressed={reactions()} onChange={setReactions}>
          Reactions
        </SegmentedToggle>
        <SegmentedToggle
          pressed={anonymise()}
          disabled={props.disabled}
          title="Replace author names"
          onChange={setAnonymise}
        >
          Anonymise names
        </SegmentedToggle>
      </SegmentedToggleGroup>
    );
  }

  it("exposes a named group of independent pressed toggles", () => {
    const { getByRole } = render(() => <Toggles />);

    expect(getByRole("group", { name: "Formatting options" })).toBeInTheDocument();
    expect(getByRole("button", { name: "Reactions" })).toHaveAttribute("aria-pressed", "false");
    expect(getByRole("button", { name: "Anonymise names" })).toHaveAttribute("aria-pressed", "true");
    expect(getByRole("button", { name: "Anonymise names" })).toHaveAttribute(
      "title",
      "Replace author names",
    );
  });

  it("toggles each option independently and marks pressed ones with a check", () => {
    const { getByRole } = render(() => <Toggles />);

    const reactions = getByRole("button", { name: "Reactions" });
    const anonymise = getByRole("button", { name: "Anonymise names" });

    expect(reactions.querySelector("svg")).toBeNull();
    expect(anonymise.querySelector("svg")).not.toBeNull();

    fireEvent.click(reactions);

    expect(reactions).toHaveAttribute("aria-pressed", "true");
    expect(reactions.querySelector("svg")).not.toBeNull();
    // The sibling toggle keeps its own state.
    expect(anonymise).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(anonymise);

    expect(anonymise).toHaveAttribute("aria-pressed", "false");
    expect(anonymise.querySelector("svg")).toBeNull();
  });

  it("does not fire onChange for a disabled toggle", () => {
    const onChange = vi.fn();

    const { getByRole } = render(() => (
      <SegmentedToggleGroup label="Formatting options">
        <SegmentedToggle pressed={false} disabled onChange={onChange}>
          Reactions
        </SegmentedToggle>
      </SegmentedToggleGroup>
    ));

    const reactions = getByRole("button", { name: "Reactions" });
    expect(reactions).toBeDisabled();

    fireEvent.click(reactions);

    expect(onChange).not.toHaveBeenCalled();
  });
});
