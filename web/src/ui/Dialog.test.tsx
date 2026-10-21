import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import Dialog from "./Dialog";

describe("Dialog", () => {
  it("renders title and content only while open", () => {
    const [open, setOpen] = createSignal(false);
    render(() => (
      <Dialog open={open()} onClose={() => setOpen(false)} title="Test dialog">
        <p>Dialog body</p>
      </Dialog>
    ));

    expect(screen.queryByText("Dialog body")).not.toBeInTheDocument();

    setOpen(true);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Test dialog")).toBeInTheDocument();
    expect(screen.getByText("Dialog body")).toBeInTheDocument();
  });

  it("renders the description when provided", () => {
    render(() => (
      <Dialog open onClose={() => {}} title="Test dialog" description="More detail">
        <p>Dialog body</p>
      </Dialog>
    ));

    expect(screen.getByText("More detail")).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(() => (
      <Dialog open onClose={onClose} title="Test dialog">
        <p>Dialog body</p>
      </Dialog>
    ));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(() => (
      <Dialog open onClose={onClose} title="Test dialog">
        <p>Dialog body</p>
      </Dialog>
    ));

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
