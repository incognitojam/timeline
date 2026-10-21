import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import ServerAvatar from "./ServerAvatar";

const ICON_URL = "https://cdn.discordapp.com/icons/900000000000000001/abc123.png";

describe("ServerAvatar", () => {
  it("renders the guild acronym for the server name", () => {
    const { container } = render(() => <ServerAvatar name="My Cool Server" />);
    expect(container.textContent).toBe("MCS");
  });

  it("exposes the acronym length so clamp() can scale the font", () => {
    const { container } = render(() => <ServerAvatar name="My Cool Server" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.getPropertyValue("--acronym-length")).toBe("3");
  });

  it("falls back to # for a name with no acronym (e.g. while loading)", () => {
    const { container } = render(() => <ServerAvatar name="" />);
    expect(container.textContent).toBe("#");
  });

  it("renders the server icon image when an iconUrl is provided", () => {
    const { container } = render(() => <ServerAvatar name="My Cool Server" iconUrl={ICON_URL} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(ICON_URL);
    expect(img?.getAttribute("alt")).toBe("My Cool Server");
    // The acronym square isn't rendered while the icon is showing.
    expect(container.textContent).toBe("");
  });

  it("shows the acronym (not an image) when iconUrl is null", () => {
    const { container } = render(() => <ServerAvatar name="My Cool Server" iconUrl={null} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("MCS");
  });

  it("falls back to the acronym when the icon fails to load", () => {
    const { container } = render(() => <ServerAvatar name="My Cool Server" iconUrl={ICON_URL} />);
    const img = container.querySelector("img");
    fireEvent.error(img!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("MCS");
  });
});
