import type { NetworkSettings } from "@shared/network-settings";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import NetworkSettingsCard from "./NetworkSettingsCard";

describe("NetworkSettingsCard", () => {
  afterEach(cleanup);

  it("saves the edited list one network per line, ignoring blank lines", async () => {
    const [settings, setSettings] = createSignal<NetworkSettings>({ blockedNetworks: ["iPhone"] });
    const onSave = vi.fn(async (next: NetworkSettings) => {
      setSettings(next);
      return next;
    });
    const view = render(() => (
      <NetworkSettingsCard settings={settings()} loadError={null} saving={false} saveError={null} onSave={onSave} />
    ));

    const textarea = view.getByLabelText("Blocked Wi-Fi networks") as HTMLTextAreaElement;
    const save = view.getByRole("button", { name: "Save" });
    expect(textarea.value).toBe("iPhone");
    expect(save).toBeDisabled();

    fireEvent.input(textarea, { target: { value: "iPhone\n\n  Train WiFi  \n" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ blockedNetworks: ["iPhone", "Train WiFi"] }));
    await waitFor(() => expect(textarea.value).toBe("iPhone\nTrain WiFi"));
    expect(save).toBeDisabled();
  });

  it("discards an unsaved edit and keeps it after a failed save", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("Failed to save network settings");
    });
    const view = render(() => (
      <NetworkSettingsCard
        settings={{ blockedNetworks: [] }}
        loadError={null}
        saving={false}
        saveError={new Error("Failed to save network settings")}
        onSave={onSave}
      />
    ));

    const textarea = view.getByLabelText("Blocked Wi-Fi networks") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "Hotel" } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(textarea.value).toBe("Hotel");
    expect(view.getByRole("alert")).toHaveTextContent("Failed to save network settings");

    fireEvent.click(view.getByRole("button", { name: "Discard changes" }));
    expect(textarea.value).toBe("");
  });
});
