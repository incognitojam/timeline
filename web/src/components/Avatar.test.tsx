import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import Avatar from "./Avatar";

describe("Avatar", () => {
  afterEach(cleanup);

  it("shows the next photo after a failed one when reused for another person", () => {
    const [person, setPerson] = createSignal({ url: "https://example.com/alice.png", name: "Alice Example" });
    const view = render(() => <Avatar url={person().url} name={person().name} />);

    fireEvent.error(view.getByRole("img", { name: "Alice Example" }));
    expect(view.getByText("AE")).toBeInTheDocument();

    setPerson({ url: "https://example.com/bob.png", name: "Bob Example" });
    expect(view.getByRole("img", { name: "Bob Example" })).toHaveAttribute("src", "https://example.com/bob.png");
  });
});
