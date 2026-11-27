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

  it.each(["close button", "Escape"])("calls onClose on %s", (intent) => {
    const onClose = vi.fn();
    render(() => (
      <Dialog open onClose={onClose} title="Test dialog">
        <p>Dialog body</p>
      </Dialog>
    ));
    if (intent === "close button") {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    } else {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    }
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to what opened it", async () => {
    const [open, setOpen] = createSignal(false);
    render(() => (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open</button>
        <Dialog open={open()} onClose={() => setOpen(false)} title="Test dialog">
          <button type="button" onClick={() => setOpen(false)}>Cancel</button>
        </Dialog>
      </>
    ));
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
